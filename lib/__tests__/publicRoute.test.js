// The admin route behind the public flag. The page itself
// (pages/watch/public/[id].js) is getServerSideProps and has no harness here,
// so its logic is covered by lib/__tests__/publicVideos.test.js plus reading
// the file; what IS testable, and most worth testing, is that a manager
// cannot make a video public.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

let sessionUser = null;
const hget = vi.fn();
const hgetall = vi.fn();
const hset = vi.fn();
const hdel = vi.fn();
const hexists = vi.fn();

vi.mock("../auth0", () => ({
  auth0: { getSession: async () => (sessionUser ? { user: sessionUser } : null) },
}));
vi.mock("../redis", () => ({
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => ({ hget, hgetall, hset, hdel, hexists }),
}));
vi.mock("../ratelimit", () => ({ allowRequest: async () => true }));

const publicRoute = (await import("../../pages/api/admin/public-videos")).default;

function signIn(email) {
  sessionUser = email ? { email } : null;
}

function redisState({ roles = {}, viewers = {}, publicVideos = {} } = {}) {
  hget.mockImplementation(async (key, field) => {
    if (key === "fablevideo:roles") return roles[field] ?? null;
    if (key === "fablevideo:viewers") return viewers[field] ?? null;
    return null;
  });
  hgetall.mockImplementation(async (key) => {
    if (key === "fablevideo:roles") return roles;
    if (key === "fablevideo:public") return publicVideos;
    return {};
  });
  hset.mockResolvedValue(1);
  hdel.mockResolvedValue(1);
}

function writesTo(key) {
  return hset.mock.calls.filter(([hashKey]) => hashKey === key);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_EMAILS = "root@example.com";
  process.env.APP_BASE_URL = "https://portal.example.com";
  delete process.env.REQUIRE_VERIFIED_EMAIL;
  sessionUser = null;
  redisState();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("authorization", () => {
  it("401s an anonymous caller", async () => {
    signIn(null);
    expect((await callRoute(publicRoute)).statusCode).toBe(401);
  });

  it("403s an approved viewer", async () => {
    signIn("crew@example.com");
    redisState({ viewers: { "crew@example.com": { addedAt: "x" } } });
    expect((await callRoute(publicRoute)).statusCode).toBe(403);
  });

  // The reason this lives on its own route: CAP.VIDEOS (which a manager
  // holds) governs the rest of the Videos tab, but publishing to the open
  // internet is a site-policy decision and needs CAP.SETTINGS.
  it("403s a MANAGER — publishing is not library management", async () => {
    signIn("mate@example.com");
    redisState({ roles: { "mate@example.com": "manager" } });
    const res = await callRoute(publicRoute, {
      method: "POST",
      body: { id: "v1", public: true },
    });
    expect(res.statusCode).toBe(403);
    expect(writesTo("fablevideo:public")).toHaveLength(0);
  });

  it("lets an admin through", async () => {
    signIn("root@example.com");
    expect((await callRoute(publicRoute)).statusCode).toBe(200);
  });

  it("guards before the method check — an unauthorised PUT gets 403, not 405", async () => {
    signIn("crew@example.com");
    redisState({ viewers: { "crew@example.com": { addedAt: "x" } } });
    const res = await callRoute(publicRoute, { method: "PUT" });
    expect(res.statusCode).toBe(403);
    expect(res.getHeader("allow")).toBeUndefined();
  });
});

describe("POST", () => {
  beforeEach(() => {
    signIn("root@example.com");
    redisState();
  });

  it("publishes only on an explicit boolean true", async () => {
    const res = await callRoute(publicRoute, {
      method: "POST",
      body: { id: "v1", public: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.public).toBe(true);
    expect(res.body.url).toBe("https://portal.example.com/watch/public/v1");
    expect(writesTo("fablevideo:public")).toHaveLength(1);
  });

  // "Truthy means publish" is exactly the bug this feature cannot afford.
  it("treats every non-true value as 'make private'", async () => {
    for (const value of ["true", 1, "yes", {}, [], undefined]) {
      hset.mockClear();
      hdel.mockClear();
      const res = await callRoute(publicRoute, {
        method: "POST",
        body: { id: "v1", public: value },
      });
      expect(res.body.public).toBe(false);
      expect(writesTo("fablevideo:public")).toHaveLength(0);
      expect(hdel).toHaveBeenCalledWith("fablevideo:public", "v1");
    }
  });

  it("turning it off returns no url", async () => {
    const res = await callRoute(publicRoute, {
      method: "POST",
      body: { id: "v1", public: false },
    });
    expect(res.body.url).toBeNull();
  });

  it("requires a video id", async () => {
    const res = await callRoute(publicRoute, { method: "POST", body: { public: true } });
    expect(res.statusCode).toBe(400);
    expect(writesTo("fablevideo:public")).toHaveLength(0);
  });
});

describe("GET", () => {
  it("lists the public videos with their addresses", async () => {
    signIn("root@example.com");
    redisState({
      publicVideos: { v1: { enabledAt: "2026-09-01", enabledBy: "root@example.com" } },
    });
    const res = await callRoute(publicRoute);
    expect(res.statusCode).toBe(200);
    expect(res.body.videos).toEqual([
      {
        id: "v1",
        enabledAt: "2026-09-01",
        enabledBy: "root@example.com",
        url: "https://portal.example.com/watch/public/v1",
      },
    ]);
  });

  it("502s rather than reporting an empty list when Redis is down", async () => {
    signIn("root@example.com");
    hgetall.mockRejectedValue(new Error("redis is down"));
    const res = await callRoute(publicRoute);
    expect(res.statusCode).toBe(502);
  });
});
