// Per-episode podcast artwork: GET /api/feed/[token]/<id>.jpg.
//
// Artwork goes through the SAME entitlement-checked route as the media, for
// the reason the media does: the URL a podcast app caches must be stable and
// must never be a signed bunny.net URL. So the properties are the media
// route's — re-check identity, scope and schedule on every fetch, mint a
// short-lived signature only after — plus two of its own: the thumbnail file
// name bunny reports is validated before it becomes a CDN path, and the feed
// document points each episode at this stable URL.
//
// Same harness and world as feedRoutes.test.js, with bunny.net's getVideo
// stubbed so no network is touched.
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

const { getVideo } = vi.hoisted(() => ({ getVideo: vi.fn() }));
vi.mock("../bunny", async (importOriginal) => ({ ...(await importOriginal()), getVideo }));

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

beforeEach(() => {
  getVideo.mockResolvedValue({ guid: VIDEO, thumbnailFileName: "thumbnail_1a2b.jpg" });
});

const art = { token: TOKEN, file: `${VIDEO}.jpg` };

describe("GET /api/feed/[token]/<id>.jpg — episode artwork", () => {
  it("redirects an entitled subscriber to the SIGNED custom thumbnail", async () => {
    world();
    const res = await callRoute(mediaRoute, { query: art });
    expect(res.statusCode).toBe(302);
    const location = res.getHeader("location");
    expect(location).toContain(`/${VIDEO}/thumbnail_1a2b.jpg`);
    expect(location).toMatch(/[?&]token=/);
    expect(location).toMatch(/[?&]expires=\d+/);
    expect(res.getHeader("cache-control")).toMatch(/private/);
  });

  it("falls back to the default thumbnail when bunny names none", async () => {
    world();
    getVideo.mockResolvedValue({ guid: VIDEO });
    const res = await callRoute(mediaRoute, { query: art });
    expect(res.getHeader("location")).toContain(`/${VIDEO}/thumbnail.jpg`);
  });

  it("re-checks approval — a removed viewer gets no artwork, same token", async () => {
    world({ viewer: null });
    const res = await callRoute(mediaRoute, { query: art });
    expect(res.statusCode).toBe(404);
    expect(getVideo).not.toHaveBeenCalled();
  });

  it("refuses a video outside the caller's group scope, before asking bunny", async () => {
    world({
      viewer: { addedAt: "x", tags: ["Crew"] },
      groups: { crew: { name: "Crew", restricted: true, videoIds: ["other-1234"] } },
    });
    const res = await callRoute(mediaRoute, { query: art });
    expect(res.statusCode).toBe(404);
    expect(getVideo).not.toHaveBeenCalled();
  });

  it("refuses a video outside its publish window", async () => {
    world({ schedule: { publishAt: "2999-01-01T00:00:00.000Z" } });
    expect((await callRoute(mediaRoute, { query: art })).statusCode).toBe(404);
  });

  it("404s when bunny does not have the video", async () => {
    world();
    getVideo.mockRejectedValue(new Error("404"));
    expect((await callRoute(mediaRoute, { query: art })).statusCode).toBe(404);
  });

  it("refuses a thumbnail file name that is not a plain file name", async () => {
    world();
    for (const name of ["../../secret.jpg", "a/b.jpg", "x.svg", "thumb.jpg?x=1"]) {
      getVideo.mockResolvedValue({ guid: VIDEO, thumbnailFileName: name });
      const res = await callRoute(mediaRoute, { query: art });
      expect(res.statusCode, name).toBe(404);
      expect(res.getHeader("location")).toBeUndefined();
    }
  });

  it("still serves the media for .mp4 — artwork did not change that path", async () => {
    world();
    const res = await callRoute(mediaRoute, { query: { token: TOKEN, file: `${VIDEO}.mp4` } });
    expect(res.getHeader("location")).toContain(`/${VIDEO}/play_720p.mp4`);
    expect(getVideo).not.toHaveBeenCalled();
  });
});

describe("the feed document", () => {
  it("points each episode at the stable artwork URL, never a CDN one", async () => {
    world();
    const res = await callRoute(feedRoute, { query: { token: TOKEN } });
    expect(res.body).toContain(
      `<itunes:image href="https://portal.example.com/api/feed/${TOKEN}/${VIDEO}.jpg" />`
    );
    expect(res.body).not.toContain("b-cdn.net");
  });
});

describe("the show's own artwork", () => {
  it("uses the built-in icon when none is set", async () => {
    world();
    const res = await callRoute(feedRoute, { query: { token: TOKEN } });
    expect(res.body).toContain('<itunes:image href="https://portal.example.com/icon-512.png" />');
  });

  it("uses the admin-set icon, through its versioned URL, when there is one", async () => {
    world();
    const base = hget.getMockImplementation();
    hget.mockImplementation(async (key, field) =>
      key === "fablevideo:app_icon" && field === "version" ? "vabc123def456" : base(key, field)
    );
    const res = await callRoute(feedRoute, { query: { token: TOKEN } });
    expect(res.body).toContain(
      '<itunes:image href="https://portal.example.com/api/app-icon/512?v=vabc123def456" />'
    );
  });
});
