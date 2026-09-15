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

// Admin notification on a new access request. Stubbed so these tests assert
// WHEN it is called (and that a failure is survivable), not what it delivers —
// the delivery paths are lib/email.js and lib/push.js, both inert here.
const { notifySpy } = vi.hoisted(() => ({ notifySpy: vi.fn() }));
vi.mock("../accessRequestNotify", () => ({ notifyNewAccessRequest: notifySpy }));

const rolesRoute = (await import("../../pages/api/admin/roles")).default;
const groupsRoute = (await import("../../pages/api/admin/groups")).default;
const accessRequestRoute = (await import("../../pages/api/access-request")).default;
const adminRequestsRoute = (await import("../../pages/api/admin/access-requests")).default;
const manifestRoute = (await import("../../pages/api/manifest")).default;
const notifyRoute = (await import("../../pages/api/admin/notify")).default;

// Role fixtures. Under custom roles "make this person a manager" means
// "create a role record and assign it", so a helper keeps the tests readable.
const MANAGER = {
  id: "manager-x",
  name: "Manager",
  capabilities: [
    "videos.read",
    "videos.manage",
    "videos.upload",
    "shares.read",
    "shares.manage",
    "analytics.read",
    "audit.read",
  ],
};
const ADMIN = {
  id: "admin-x",
  name: "Admin",
  capabilities: [
    ...MANAGER.capabilities,
    "viewers.read",
    "viewers.manage",
    "groups.manage",
    "roles.manage",
    "settings.manage",
    "broadcast.send",
  ],
};

function asRole(email, role, extra = {}) {
  return {
    ...extra,
    roles: { [role.id]: role, ...(extra.roles || {}) },
    assignments: { [email]: [role.id], ...(extra.assignments || {}) },
  };
}

// Route the shared hget/hgetall stubs by key.
function redisState({
  roles = {},
  assignments = {},
  viewers = {},
  groups = {},
  requests = {},
  settings = {},
} = {}) {
  hget.mockImplementation(async (key, field) => {
    if (key === "fablevideo:roles") return roles[field] ?? null;
    if (key === "fablevideo:user:roles") return assignments[field] ?? null;
    if (key === "fablevideo:viewers") return viewers[field] ?? null;
    if (key === "fablevideo:groups") return groups[field] ?? null;
    if (key === "fablevideo:requests") return requests[field] ?? null;
    if (key === "fablevideo:settings") return settings[field] ?? null;
    return null;
  });
  hgetall.mockImplementation(async (key) => {
    if (key === "fablevideo:roles") return roles;
    if (key === "fablevideo:user:roles") return assignments;
    if (key === "fablevideo:viewers") return viewers;
    if (key === "fablevideo:groups") return groups;
    if (key === "fablevideo:requests") return requests;
    if (key === "fablevideo:settings") return settings;
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
  notifySpy.mockReset();
  notifySpy.mockResolvedValue({ emailed: 0, pushed: 0, recipients: 0 });
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

  it("403s a video manager on a people-management route", async () => {
    signIn("mate@example.com");
    redisState(asRole("mate@example.com", MANAGER));
    for (const route of [rolesRoute, groupsRoute, adminRequestsRoute]) {
      const res = await callRoute(route);
      expect(res.statusCode).toBe(403);
    }
  });

  it("lets an env admin through without any stored role", async () => {
    signIn("root@example.com");
    const res = await callRoute(rolesRoute);
    expect(res.statusCode).toBe(200);
    expect(res.body.actor.owner).toBe(true);
  });

  it("lets a Redis-promoted admin through", async () => {
    signIn("boss@example.com");
    redisState(asRole("boss@example.com", ADMIN));
    const res = await callRoute(groupsRoute);
    expect(res.statusCode).toBe(200);
  });
});

describe("admin routes: email verification", () => {
  it("403s an unverified caller when enforcement is on", async () => {
    process.env.REQUIRE_VERIFIED_EMAIL = "true";
    signIn("boss@example.com", { email_verified: false });
    redisState(asRole("boss@example.com", ADMIN));
    const res = await callRoute(rolesRoute);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/verify/i);
  });

  it("allows a verified caller when enforcement is on", async () => {
    process.env.REQUIRE_VERIFIED_EMAIL = "true";
    signIn("boss@example.com", { email_verified: true });
    redisState(asRole("boss@example.com", ADMIN));
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
    redisState(asRole("boss@example.com", ADMIN));
    expect((await callRoute(rolesRoute)).statusCode).toBe(200);
  });
});

// --- role assignment guardrails -------------------------------------------

// --- role administration ------------------------------------------------
//
// The fixed-role model's two guardrails ("can't change your own role", "can't
// change an ADMIN_EMAILS address's role") are gone, replaced by something
// stronger: the no-escalation ceiling, plus the fact that an owner's
// capabilities never come from Redis at all, so an assignment cannot touch
// them however it is written.
describe("/api/admin/roles", () => {
  it("lets an owner through and reports the catalog and their own set", async () => {
    signIn("root@example.com");
    const res = await callRoute(rolesRoute);
    expect(res.statusCode).toBe(200);
    expect(res.body.actor.owner).toBe(true);
    expect(res.body.catalog.length).toBeGreaterThan(0);
    // Every catalogued capability, so the UI greys out nothing for an owner.
    expect(res.body.actor.capabilities).toContain("roles.manage");
    expect(res.body.actor.capabilities).toContain("settings.manage");
  });

  it("403s someone holding every capability EXCEPT roles.manage", async () => {
    signIn("mate@example.com");
    redisState(asRole("mate@example.com", MANAGER));
    expect((await callRoute(rolesRoute)).statusCode).toBe(403);
  });

  describe("the no-escalation ceiling", () => {
    // A delegated role manager: can administer roles, but holds only the
    // video capabilities besides.
    const LIMITED = {
      id: "limited-x",
      name: "Video lead",
      capabilities: ["roles.manage", "videos.read", "videos.manage"],
    };

    beforeEach(() => {
      signIn("lead@example.com");
      redisState(asRole("lead@example.com", LIMITED));
    });

    it("lets them create a role out of capabilities they hold", async () => {
      const res = await callRoute(rolesRoute, {
        method: "POST",
        body: { name: "Editor", capabilities: ["videos.read"] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.role.capabilities).toEqual(["videos.read"]);
    });

    it("refuses a role granting something they do not hold, and names it", async () => {
      const res = await callRoute(rolesRoute, {
        method: "POST",
        body: { name: "Sneaky", capabilities: ["videos.read", "settings.manage"] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body.refused).toEqual(["settings.manage"]);
      expect(writesTo("fablevideo:roles")).toHaveLength(0);
    });

    // Editing a role you could not have created is the same escalation by
    // another door, so the CURRENT set is checked as well as the new one.
    it("refuses to edit a role more powerful than themselves", async () => {
      redisState(
        asRole("lead@example.com", LIMITED, { roles: { "admin-x": ADMIN } })
      );
      const res = await callRoute(rolesRoute, {
        method: "PUT",
        body: { id: "admin-x", name: "Admin", capabilities: ["videos.read"] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body.refused).toContain("settings.manage");
      expect(writesTo("fablevideo:roles")).toHaveLength(0);
    });

    it("refuses to delete a role more powerful than themselves", async () => {
      redisState(
        asRole("lead@example.com", LIMITED, { roles: { "admin-x": ADMIN } })
      );
      const res = await callRoute(rolesRoute, { method: "DELETE", query: { id: "admin-x" } });
      expect(res.statusCode).toBe(403);
      expect(hdel).not.toHaveBeenCalledWith("fablevideo:roles", "admin-x");
    });

    it("refuses to ASSIGN a role beyond their own set", async () => {
      redisState(
        asRole("lead@example.com", LIMITED, { roles: { "admin-x": ADMIN } })
      );
      const res = await callRoute(rolesRoute, {
        method: "PATCH",
        body: { email: "someone@example.com", roleIds: ["admin-x"] },
      });
      expect(res.statusCode).toBe(403);
      expect(writesTo("fablevideo:user:roles")).toHaveLength(0);
    });

    // "Demote the person above me" is escalation too, so stripping is checked
    // against the same ceiling as granting.
    it("refuses to STRIP a role beyond their own set", async () => {
      redisState(
        asRole("lead@example.com", LIMITED, {
          roles: { "admin-x": ADMIN },
          assignments: { "boss@example.com": ["admin-x"] },
        })
      );
      const res = await callRoute(rolesRoute, {
        method: "PATCH",
        body: { email: "boss@example.com", roleIds: [] },
      });
      expect(res.statusCode).toBe(403);
      expect(writesTo("fablevideo:user:roles")).toHaveLength(0);
    });
  });

  describe("an owner", () => {
    beforeEach(() => {
      signIn("root@example.com");
      redisState({ roles: { "admin-x": ADMIN } });
    });

    it("can grant anything in the catalog", async () => {
      const res = await callRoute(rolesRoute, {
        method: "POST",
        body: { name: "Everything", capabilities: ["settings.manage", "roles.manage"] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.role.capabilities).toEqual(["roles.manage", "settings.manage"]);
    });

    it("silently drops an invented capability rather than storing it", async () => {
      const res = await callRoute(rolesRoute, {
        method: "POST",
        body: { name: "Forged", capabilities: ["videos.read", "god.mode"] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.role.capabilities).toEqual(["videos.read"]);
    });

    it("rejects a nameless role", async () => {
      const res = await callRoute(rolesRoute, {
        method: "POST",
        body: { name: "   ", capabilities: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it("assigns roles by id", async () => {
      const res = await callRoute(rolesRoute, {
        method: "PATCH",
        body: { email: "New@Example.com", roleIds: ["admin-x"] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ email: "new@example.com", roleIds: ["admin-x"] });
      expect(hset).toHaveBeenCalledWith("fablevideo:user:roles", {
        "new@example.com": ["admin-x"],
      });
    });

    it("drops a role id with no surviving record", async () => {
      const res = await callRoute(rolesRoute, {
        method: "PATCH",
        body: { email: "new@example.com", roleIds: ["admin-x", "ghost-x"] },
      });
      expect(res.body.roleIds).toEqual(["admin-x"]);
    });

    it("rejects an invalid email", async () => {
      const res = await callRoute(rolesRoute, {
        method: "PATCH",
        body: { email: "not-an-email", roleIds: [] },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // An owner's capabilities come from ADMIN_EMAILS, never Redis, so this is
  // structurally impossible rather than guarded against — which is why the
  // old "can't change an ADMIN_EMAILS address's role" check is gone.
  it("cannot demote an owner by writing assignments, even with none stored", async () => {
    signIn("root@example.com");
    redisState({ assignments: { "root@example.com": [] } });
    const res = await callRoute(rolesRoute);
    expect(res.statusCode).toBe(200);
    expect(res.body.actor.owner).toBe(true);
    expect(res.body.actor.capabilities).toContain("settings.manage");
  });

  it("405s an unsupported method and advertises what is allowed", async () => {
    signIn("root@example.com");
    const res = await callRoute(rolesRoute, { method: "OPTIONS" });
    expect(res.statusCode).toBe(405);
    expect(res.getHeader("allow")).toBe("GET, POST, PUT, PATCH, DELETE");
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

  it("notifies the admins on a genuinely new request", async () => {
    signIn("stranger@example.com");
    await callRoute(accessRequestRoute, { method: "POST", body: { message: "hello" } });
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0][0]).toMatchObject({ email: "stranger@example.com" });
  });

  // A refresh loop must not become a notification flood: re-asking while a
  // request is already pending is a no-op, notification included.
  it("does not re-notify when a request is already pending", async () => {
    signIn("stranger@example.com");
    redisState({
      requests: {
        "stranger@example.com": { status: "pending", requestedAt: "2026-01-01" },
      },
    });
    const res = await callRoute(accessRequestRoute, { method: "POST" });
    expect(res.body.alreadyRequested).toBe(true);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  // The requester's ask is the product; the notification is a convenience.
  it("still records the request when notification throws", async () => {
    signIn("stranger@example.com");
    notifySpy.mockRejectedValue(new Error("resend is down"));
    const res = await callRoute(accessRequestRoute, { method: "POST" });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(writesTo("fablevideo:requests")).toHaveLength(1);
  });
});

// --- guard ordering --------------------------------------------------------

describe("/api/admin/notify guards before it inspects the method", () => {
  // Checking req.method first answered an unauthorised caller with a 405 that
  // named the verb the route wants, confirming the route exists. This was the
  // only admin route in the repo doing so.
  it("403s an unauthorised GET rather than 405ing it", async () => {
    signIn("crew@example.com");
    redisState({ viewers: { "crew@example.com": { addedAt: "x" } } });
    const res = await callRoute(notifyRoute, { method: "GET" });
    expect(res.statusCode).toBe(403);
    expect(res.getHeader("allow")).toBeUndefined();
  });

  it("401s an anonymous GET rather than 405ing it", async () => {
    signIn(null);
    const res = await callRoute(notifyRoute, { method: "GET" });
    expect(res.statusCode).toBe(401);
    expect(res.getHeader("allow")).toBeUndefined();
  });

  // ...and an authorised caller still gets the method check it deserves.
  it("405s an authorised GET, advertising POST", async () => {
    signIn("root@example.com");
    const res = await callRoute(notifyRoute, { method: "GET" });
    expect(res.statusCode).toBe(405);
    expect(res.getHeader("allow")).toBe("POST");
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

// --- the PWA manifest -------------------------------------------------------

describe("GET /api/manifest", () => {
  beforeEach(() => {
    // No session at all — this route is public, unlike everything above it.
    signIn(null);
  });

  it("requires no session", async () => {
    redisState();
    const res = await callRoute(manifestRoute);
    expect(res.statusCode).toBe(200);
  });

  it("serves the admin-set name, resolved and shortened", async () => {
    redisState({ settings: { siteName: "Crew Videos" } });
    const res = await callRoute(manifestRoute);
    expect(res.body.name).toBe("Crew Videos");
    expect(res.body.short_name).toBe("Crew Videos");
    expect(res.getHeader("content-type")).toBe("application/manifest+json");
  });

  it("falls back to the default when nothing is stored", async () => {
    redisState();
    const res = await callRoute(manifestRoute);
    expect(res.body.name).toBe("Marine Video Portal");
    expect(res.body.short_name).toBe("Marine Video");
  });

  // A cosmetic value must never break PWA installability — a Redis error
  // still has to return a valid, usable manifest.
  it("falls back to the default when the read throws", async () => {
    hget.mockRejectedValue(new Error("redis down"));
    hgetall.mockRejectedValue(new Error("redis down"));
    const res = await callRoute(manifestRoute);
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe("Marine Video Portal");
  });

  it("keeps the icon list intact", async () => {
    redisState();
    const res = await callRoute(manifestRoute);
    expect(res.body.icons).toHaveLength(3);
    expect(res.body.icons.map((i) => i.src)).toEqual([
      "/icon-192.png",
      "/icon-512.png",
      "/icon-maskable-512.png",
    ]);
  });

  it("405s an unsupported method", async () => {
    const res = await callRoute(manifestRoute, { method: "POST" });
    expect(res.statusCode).toBe(405);
    expect(res.getHeader("allow")).toBe("GET");
  });
});
