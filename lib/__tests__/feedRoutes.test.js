// The podcast feed's whole security argument is "the token is only an
// identity claim — entitlement is re-resolved on every fetch". That is a
// claim about behaviour over time, so it is tested the way it is lived:
// resolve once successfully, change the world in Redis, resolve again, and
// assert the second answer differs.
//
// These drive the real route handlers through the existing fake req/res
// harness, with Auth0 and Redis stubbed (see helpers/route.js).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

const hget = vi.fn();
const hgetall = vi.fn();
const hset = vi.fn();
const hdel = vi.fn();

vi.mock("../auth0", () => ({ auth0: { getSession: async () => null } }));
vi.mock("../redis", () => ({
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => ({ hget, hgetall, hset, hdel }),
}));
vi.mock("../ratelimit", () => ({ allowRequest: async () => true }));

// bunny.net is never really called; the library list is stubbed at the
// videoList seam so these tests are about authorization, not encoding.
const { fetchVideoLibrary } = vi.hoisted(() => ({ fetchVideoLibrary: vi.fn() }));
vi.mock("../videoList", () => ({ fetchVideoLibrary }));

const feedRoute = (await import("../../pages/api/feed/[token]")).default;
const mediaRoute = (await import("../../pages/api/feed/[token]/[file]")).default;

const TOKEN = "a".repeat(43);
const VIDEO = "abc-12345";

// One place to describe "the state of the world", so a test can change one
// fact and leave the rest alone.
function world({
  podcastEnabled = true,
  tokenEmail = "crew@example.com",
  viewer = { addedAt: "x", tags: [] },
  role = null,
  groups = {},
  schedule = null,
} = {}) {
  hget.mockImplementation(async (key, field) => {
    if (key === "fablevideo:settings") return field === "siteName" ? "Grace Chapel" : null;
    if (key === "fablevideo:feed:tokens") return field === TOKEN ? tokenEmail : null;
    if (key === "fablevideo:roles") return role;
    if (key === "fablevideo:viewers") return viewer;
    if (key === "fablevideo:schedule") return schedule;
    return null;
  });
  hgetall.mockImplementation(async (key) => {
    if (key === "fablevideo:settings") return { podcastEnabled };
    if (key === "fablevideo:groups") return groups;
    return {};
  });
  hset.mockResolvedValue(1);
  hdel.mockResolvedValue(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_EMAILS = "root@example.com";
  process.env.APP_BASE_URL = "https://portal.example.com";
  process.env.BUNNY_CDN_HOSTNAME = "vz-test.b-cdn.net";
  process.env.BUNNY_TOKEN_AUTH_KEY = "test-key";
  delete process.env.REQUIRE_VERIFIED_EMAIL;
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetchVideoLibrary.mockResolvedValue({
    videos: [
      {
        id: VIDEO,
        title: "Sunday morning",
        length: 5400,
        notes: "Philippians",
        dateUploaded: "2026-09-06T09:30:00Z",
        collectionId: "",
        thumbnail: null,
      },
    ],
    thumbnails: false,
  });
  world();
});

describe("GET /api/feed/[token]", () => {
  it("serves RSS to an approved subscriber", async () => {
    const res = await callRoute(feedRoute, { query: { token: TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.getHeader("content-type")).toMatch(/application\/rss\+xml/);
    expect(res.body).toContain("<rss version=\"2.0\"");
    expect(res.body).toContain("<title>Sunday morning</title>");
    // The enclosure points at THIS APP, never at bunny.net — the media route
    // re-checks entitlement before any CDN url is minted.
    expect(res.body).toContain(`/api/feed/${TOKEN}/${VIDEO}.mp4`);
    expect(res.body).not.toContain("b-cdn.net");
  });

  it("sends no body for a HEAD request", async () => {
    const res = await callRoute(feedRoute, { method: "HEAD", query: { token: TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
  });

  it("marks the response private — it differs per subscriber", async () => {
    const res = await callRoute(feedRoute, { query: { token: TOKEN } });
    expect(res.getHeader("cache-control")).toMatch(/^private/);
    expect(res.getHeader("x-robots-tag")).toMatch(/noindex/);
  });

  it("404s an unknown token", async () => {
    const res = await callRoute(feedRoute, { query: { token: "b".repeat(43) } });
    expect(res.statusCode).toBe(404);
  });

  it("404s a malformed token", async () => {
    for (const token of ["", "short", "../../admin"]) {
      expect((await callRoute(feedRoute, { query: { token } })).statusCode).toBe(404);
    }
  });

  // Every denial is the same 404: a feed URL gets pasted around, and the
  // response must not distinguish "no such token" from "no longer approved".
  it("404s an unapproved account with the same response as an unknown token", async () => {
    world({ viewer: null });
    const denied = await callRoute(feedRoute, { query: { token: TOKEN } });
    world({ tokenEmail: null });
    const unknown = await callRoute(feedRoute, { query: { token: TOKEN } });
    expect(denied.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(denied.body).toEqual(unknown.body);
  });

  it("404s when the admin has switched the feature off", async () => {
    world({ podcastEnabled: false });
    expect((await callRoute(feedRoute, { query: { token: TOKEN } })).statusCode).toBe(404);
  });

  it("404s when the podcast setting is unreadable — fails closed", async () => {
    hgetall.mockRejectedValue(new Error("redis is down"));
    expect((await callRoute(feedRoute, { query: { token: TOKEN } })).statusCode).toBe(404);
  });

  // The point of reusing fetchVideoLibrary: group scope is applied there,
  // once, so the feed cannot show what the website would not.
  it("passes the caller's group scope through to the library", async () => {
    world({
      viewer: { addedAt: "x", tags: ["Team A"] },
      groups: { "team a": { restricted: true, videoIds: ["other-video"] } },
    });
    await callRoute(feedRoute, { query: { token: TOKEN } });
    expect(fetchVideoLibrary).toHaveBeenCalledWith(["other-video"]);
  });

  it("405s a POST and advertises what is allowed", async () => {
    const res = await callRoute(feedRoute, { method: "POST", query: { token: TOKEN } });
    expect(res.statusCode).toBe(405);
    expect(res.getHeader("allow")).toBe("GET, HEAD");
  });
});

// The claim in the design, tested as a sequence rather than a snapshot.
describe("entitlement is re-resolved on every fetch, not carried in the token", () => {
  it("stops serving the moment the viewer is removed — same token", async () => {
    expect((await callRoute(feedRoute, { query: { token: TOKEN } })).statusCode).toBe(200);
    world({ viewer: null }); // the admin removes them
    expect((await callRoute(feedRoute, { query: { token: TOKEN } })).statusCode).toBe(404);
  });

  it("narrows the episode list the moment a group restriction lands", async () => {
    await callRoute(feedRoute, { query: { token: TOKEN } });
    expect(fetchVideoLibrary).toHaveBeenLastCalledWith(null);
    world({
      viewer: { addedAt: "x", tags: ["Team A"] },
      groups: { "team a": { restricted: true, videoIds: [] } },
    });
    await callRoute(feedRoute, { query: { token: TOKEN } });
    expect(fetchVideoLibrary).toHaveBeenLastCalledWith([]);
  });

  it("stops serving the moment an admin turns the feature off", async () => {
    expect((await callRoute(feedRoute, { query: { token: TOKEN } })).statusCode).toBe(200);
    world({ podcastEnabled: false });
    expect((await callRoute(feedRoute, { query: { token: TOKEN } })).statusCode).toBe(404);
  });
});

describe("GET /api/feed/[token]/[file] — the episode media", () => {
  const query = { token: TOKEN, file: `${VIDEO}.mp4` };

  it("redirects an entitled subscriber to a signed CDN url", async () => {
    const res = await callRoute(mediaRoute, { query });
    expect(res.statusCode).toBe(302);
    const location = res.getHeader("location");
    expect(location).toContain(`/${VIDEO}/play_720p.mp4`);
    // Signed and time-limited — never a bare, permanent file URL.
    expect(location).toMatch(/[?&]token=/);
    expect(location).toMatch(/[?&]expires=\d+/);
  });

  it("never puts the CDN url in a cacheable-by-anyone response", async () => {
    const res = await callRoute(mediaRoute, { query });
    expect(res.getHeader("cache-control")).toMatch(/^private/);
  });

  it("re-checks approval, not just the token", async () => {
    world({ viewer: null });
    const res = await callRoute(mediaRoute, { query });
    expect(res.statusCode).toBe(404);
    expect(res.getHeader("location")).toBeUndefined();
  });

  // A subscriber's app may hold a feed for days; the episode must be
  // re-authorized against today's groups, not the feed's.
  it("refuses a video outside the caller's group scope", async () => {
    world({
      viewer: { addedAt: "x", tags: ["Team A"] },
      groups: { "team a": { restricted: true, videoIds: ["a-different-video"] } },
    });
    const res = await callRoute(mediaRoute, { query });
    expect(res.statusCode).toBe(404);
    expect(res.getHeader("location")).toBeUndefined();
  });

  it("refuses a video outside its publish window", async () => {
    world({ schedule: { publishAt: "2099-01-01T00:00:00Z", expiresAt: null } });
    const res = await callRoute(mediaRoute, { query });
    expect(res.statusCode).toBe(404);
    expect(res.getHeader("location")).toBeUndefined();
  });

  // The deliberate inversion: unlike the signed-in watch page, an unreadable
  // schedule here denies rather than assuming "no constraint".
  it("refuses when the schedule is unreadable — fails closed", async () => {
    hget.mockImplementation(async (key, field) => {
      if (key === "fablevideo:schedule") throw new Error("redis is down");
      if (key === "fablevideo:feed:tokens") return field === TOKEN ? "crew@example.com" : null;
      if (key === "fablevideo:viewers") return { addedAt: "x", tags: [] };
      return null;
    });
    const res = await callRoute(mediaRoute, { query });
    expect(res.statusCode).toBe(404);
    expect(res.getHeader("location")).toBeUndefined();
  });

  it("refuses a file name that isn't a plain <id>.mp4", async () => {
    for (const file of ["../../secret.mp4", `${VIDEO}.txt`, "playlist.m3u8", "", `${VIDEO}/x.mp4`]) {
      const res = await callRoute(mediaRoute, { query: { token: TOKEN, file } });
      expect(res.statusCode).toBe(404);
      expect(res.getHeader("location")).toBeUndefined();
    }
  });

  it("404s when the pull zone is not configured", async () => {
    delete process.env.BUNNY_CDN_HOSTNAME;
    const res = await callRoute(mediaRoute, { query });
    expect(res.statusCode).toBe(404);
  });
});
