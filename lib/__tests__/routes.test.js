// First route-handler coverage in this repo.
//
// Until now lint and build were the only automated checks on any /api/**
// handler, so the things most worth getting right — that a guard runs BEFORE
// the work, that the right status code comes back, that a privilege check
// can't be talked out of — were verified only by reading the code.
//
// These tests drive real handlers through a fake req/res, with Auth0 and
// Redis stubbed. They assert the authorization boundary, not business logic.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

// --- stubs -----------------------------------------------------------------

let sessionUser = null;
const hget = vi.fn();
const hgetall = vi.fn();
const hset = vi.fn();
const hdel = vi.fn();

vi.mock("../auth0", () => ({
  auth0: { getSession: async () => (sessionUser ? { user: sessionUser } : null) },
}));

vi.mock("../redis", () => ({
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => ({ hget, hgetall, hset, hdel }),
}));

// The limiter fails open by design; here it simply always allows so a test
// failure can never be a rate-limit surprise.
vi.mock("../ratelimit", () => ({ allowRequest: async () => true }));

const rolesRoute = (await import("../../pages/api/admin/roles")).default;
const groupsRoute = (await import("../../pages/api/admin/groups")).default;
const accessRequestRoute = (await import("../../pages/api/access-request")).default;
const adminRequestsRoute = (await import("../../pages/api/admin/access-requests")).default;

// Route the shared hget/hgetall stubs by key.
function redisState({ roles = {}, viewers = {}, groups = {}, requests = {} } = {}) {
  hget.mockImplementation(async (key, field) => {
    if (key === "fablevideo:roles") return roles[field] ?? null;
    if (key === "fablevideo:viewers") return viewers[field] ?? null;
    if (key === "fablevideo:groups") return groups[field] ?? null;
    if (key === "fablevideo:requests") return requests[field] ?? null;
    return null;
  });
  hgetall.mockImplementation(async (key) => {
    if (key === "fablevideo:roles") return roles;
    if (key === "fablevideo:viewers") return viewers;
    if (key === "fablevideo:groups") return groups;
    if (key === "fablevideo:requests") return requests;
    return {};
  });
  hset.mockResolvedValue(1);
  hdel.mockResolvedValue(1);
}

// The guards also stamp last-seen via hset, so "did this route write?" has
// to be asked about the specific hash, not about hset in general.
function writesTo(key) {
  return hset.mock.calls.filter(([hashKey]) => hashKey === key);
}

function signIn(email, extra = {}) {
  sessionUser = email ? { email, ...extra } : null;
}

beforeEach(() => {
  process.env.ADMIN_EMAILS = "root@example.com";
  delete process.env.REQUIRE_VERIFIED_EMAIL;
  sessionUser = null;
  hget.mockReset();
  hgetall.mockReset();
  hset.mockReset();
  hdel.mockReset();
  redisState();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- the guard boundary ----------------------------------------------------

describe("admin routes: authentication", () => {
  it("401s an anonymous caller", async () => {
    signIn(null);
    const res = await callRoute(rolesRoute);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/login/i);
  });

  it("403s a signed-in viewer with no capability", async () => {
    signIn("crew@example.com");
    redisState({ viewers: { "crew@example.com": { addedAt: "x" } } });
    const res = await callRoute(rolesRoute);
    expect(res.statusCode).toBe(403);
  });

  it("403s a manager on a people-management route", async () => {
    signIn("mate@example.com");
    redisState({ roles: { "mate@example.com": "manager" } });
    for (const route of [rolesRoute, groupsRoute, adminRequestsRoute]) {
      const res = await callRoute(route);
      expect(res.statusCode).toBe(403);
    }
  });

  it("lets an env admin through without any stored role", async () => {
    signIn("root@example.com");
    const res = await callRoute(rolesRoute);
    expect(res.statusCode).toBe(200);
    expect(res.body.roles["root@example.com"]).toBe("admin");
  });

  it("lets a Redis-promoted admin through", async () => {
    signIn("boss@example.com");
    redisState({ roles: { "boss@example.com": "admin" } });
    const res = await callRoute(groupsRoute);
    expect(res.statusCode).toBe(200);
  });
});

describe("admin routes: email verification", () => {
  it("403s an unverified caller when enforcement is on", async () => {
    process.env.REQUIRE_VERIFIED_EMAIL = "true";
    signIn("boss@example.com", { email_verified: false });
    redisState({ roles: { "boss@example.com": "admin" } });
    const res = await callRoute(rolesRoute);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/verify/i);
  });

  it("allows a verified caller when enforcement is on", async () => {
    process.env.REQUIRE_VERIFIED_EMAIL = "true";
    signIn("boss@example.com", { email_verified: true });
    redisState({ roles: { "boss@example.com": "admin" } });
    expect((await callRoute(rolesRoute)).statusCode).toBe(200);
  });

  // The recovery path: enforcement must never lock out the bootstrap admin,
  // who is the one person able to switch it back off.
  it("never blocks an ADMIN_EMAILS address, even unverified", async () => {
    process.env.REQUIRE_VERIFIED_EMAIL = "true";
    signIn("root@example.com", { email_verified: false });
    expect((await callRoute(rolesRoute)).statusCode).toBe(200);
  });

  it("ignores the claim entirely when enforcement is off", async () => {
    signIn("boss@example.com", { email_verified: false });
    redisState({ roles: { "boss@example.com": "admin" } });
    expect((await callRoute(rolesRoute)).statusCode).toBe(200);
  });
});

// --- role assignment guardrails -------------------------------------------

describe("PATCH /api/admin/roles", () => {
  beforeEach(() => {
    signIn("boss@example.com");
    redisState({ roles: { "boss@example.com": "admin" } });
  });

  it("refuses to change your own role", async () => {
    const res = await callRoute(rolesRoute, {
      method: "PATCH",
      body: { email: "boss@example.com", role: "viewer" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/your own role/i);
    expect(writesTo("fablevideo:roles")).toHaveLength(0);
  });

  it("refuses to change an ADMIN_EMAILS address's role", async () => {
    const res = await callRoute(rolesRoute, {
      method: "PATCH",
      body: { email: "root@example.com", role: "viewer" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/ADMIN_EMAILS/);
    expect(writesTo("fablevideo:roles")).toHaveLength(0);
  });

  it("rejects an unknown role instead of silently clamping it", async () => {
    const res = await callRoute(rolesRoute, {
      method: "PATCH",
      body: { email: "someone@example.com", role: "superadmin" },
    });
    expect(res.statusCode).toBe(400);
    expect(writesTo("fablevideo:roles")).toHaveLength(0);
  });

  it("rejects an invalid email", async () => {
    const res = await callRoute(rolesRoute, {
      method: "PATCH",
      body: { email: "not-an-email", role: "manager" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("assigns a valid role", async () => {
    const res = await callRoute(rolesRoute, {
      method: "PATCH",
      body: { email: "New@Example.com", role: "manager" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ email: "new@example.com", role: "manager" });
    expect(hset).toHaveBeenCalledWith("fablevideo:roles", {
      "new@example.com": "manager",
    });
  });

  it("405s an unsupported method and advertises what is allowed", async () => {
    const res = await callRoute(rolesRoute, { method: "PUT" });
    expect(res.statusCode).toBe(405);
    expect(res.getHeader("allow")).toBe("GET, PATCH");
  });
});

// --- access requests -------------------------------------------------------

describe("POST /api/access-request", () => {
  it("401s an anonymous caller", async () => {
    signIn(null);
    expect((await callRoute(accessRequestRoute, { method: "POST" })).statusCode).toBe(401);
  });

  // The whole point of this route: an unapproved but signed-in person may
  // call it. If it required approval it could never be used.
  it("accepts a signed-in but unapproved caller", async () => {
    signIn("stranger@example.com");
    const res = await callRoute(accessRequestRoute, {
      method: "POST",
      body: { message: "deck crew" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(writesTo("fablevideo:requests")).toHaveLength(1);
  });

  it("refuses someone who already has access", async () => {
    signIn("crew@example.com");
    redisState({ viewers: { "crew@example.com": { addedAt: "x" } } });
    const res = await callRoute(accessRequestRoute, { method: "POST" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/already have access/i);
  });

  it("does not duplicate an existing request", async () => {
    signIn("stranger@example.com");
    redisState({
      requests: {
        "stranger@example.com": { status: "pending", requestedAt: "2026-01-01" },
      },
    });
    const res = await callRoute(accessRequestRoute, { method: "POST" });
    expect(res.body.alreadyRequested).toBe(true);
    expect(writesTo("fablevideo:requests")).toHaveLength(0);
  });

  // The identity comes from the session, never the body — otherwise anyone
  // could fill the admin queue with other people's addresses.
  it("ignores an email supplied in the body", async () => {
    signIn("stranger@example.com");
    await callRoute(accessRequestRoute, {
      method: "POST",
      body: { email: "someone.else@example.com" },
    });
    const [, payload] = writesTo("fablevideo:requests")[0];
    expect(Object.keys(payload)).toEqual(["stranger@example.com"]);
  });

  it("rejects an over-long note", async () => {
    signIn("stranger@example.com");
    const res = await callRoute(accessRequestRoute, {
      method: "POST",
      body: { message: "x".repeat(301) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/admin/access-requests", () => {
  beforeEach(() => {
    signIn("root@example.com");
    redisState({
      requests: {
        "stranger@example.com": { status: "pending", requestedAt: "2026-01-01" },
      },
    });
  });

  it("approves by adding the viewer and clearing the request", async () => {
    const res = await callRoute(adminRequestsRoute, {
      method: "POST",
      body: { email: "stranger@example.com", decision: "approve" },
    });
    expect(res.statusCode).toBe(200);
    expect(hset).toHaveBeenCalledWith(
      "fablevideo:viewers",
      expect.objectContaining({ "stranger@example.com": expect.any(Object) })
    );
    expect(hdel).toHaveBeenCalledWith(
      "fablevideo:requests",
      "stranger@example.com"
    );
  });

  it("404s a decision on a request that doesn't exist", async () => {
    const res = await callRoute(adminRequestsRoute, {
      method: "POST",
      body: { email: "nobody@example.com", decision: "approve" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an unknown decision", async () => {
    const res = await callRoute(adminRequestsRoute, {
      method: "POST",
      body: { email: "stranger@example.com", decision: "maybe" },
    });
    expect(res.statusCode).toBe(400);
  });
});
