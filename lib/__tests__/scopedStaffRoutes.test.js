// Group-scoped staff, end to end through the real route handlers.
//
// One staff member holds EVERY capability but is limited to the Youth group.
// Each test asks a route to do something outside Youth and checks that it is
// refused, and asks it to do the same inside Youth and checks that it works —
// so a refusal can never pass by the route simply being broken.
//
// The world:
//   groups   youth (restricted: v1, v3)   deck (restricted: v2, v3)
//            open  (unrestricted label)
//   videos   v1 youth only · v2 deck only · v3 both · v4 in no group
//   viewers  y1 [Youth] · d1 [Deck] · both [Youth, Deck] · free [] (sees all)
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { callRoute } from "./helpers/route";
import { mem } from "./helpers/memoryRedis";

const state = vi.hoisted(() => ({ email: null, deleted: [], created: [], updated: [] }));

vi.mock("../redis", async () => (await import("./helpers/memoryRedis")).redisModule);
vi.mock("../auth0", () => ({
  auth0: { getSession: async () => (state.email ? { user: { email: state.email } } : null) },
}));
vi.mock("../ratelimit", () => ({ allowRequest: async () => true }));
vi.mock("../push", () => ({
  maybeAnnounceReadyVideos: async () => {},
  pushEnabled: () => false,
  sendPushToApproved: async () => ({ sent: 0 }),
}));
vi.mock("../transcriptCollect", () => ({ collectFinishedTranscripts: async () => ({ collected: [] }) }));
vi.mock("../email", () => ({
  emailEnabled: () => false,
  emailFrom: () => null,
  sendShareEmail: async () => false,
  sendBulkShareEmail: async () => false,
}));
vi.mock("../bunny", () => {
  const library = () => [
    { guid: "v1", title: "One", collectionId: "", status: 4, views: 5 },
    { guid: "v2", title: "Two", collectionId: "", status: 4, views: 7 },
    { guid: "v3", title: "Three", collectionId: "", status: 4, views: 1 },
    { guid: "v4", title: "Four", collectionId: "", status: 4, views: 9 },
  ];
  return {
    listAllVideosWithStatus: async () => ({ videos: library(), truncated: false, total: 4 }),
    listAllVideos: async () => library(),
    getVideo: async (id) => {
      const video = library().find((v) => v.guid === id);
      if (!video) throw new Error("404");
      return video;
    },
    updateVideo: async (id, patch) => state.updated.push([id, patch]),
    deleteVideo: async (id) => state.deleted.push(id),
    createVideo: async (title) => (state.created.push(title), { guid: "new1", title }),
    signTusUpload: () => ({ signature: "sig" }),
    thumbnailUrl: () => null,
    thumbnailsEnabled: () => false,
    videoState: () => "ready",
    listCollections: async () => [],
    createCollection: async () => ({ guid: "c1" }),
    deleteCollection: async () => {},
    getStatistics: async () => ({ viewsChart: { "2026-09-01": 3 }, watchTimeChart: {} }),
    transcribeVideo: async () => {},
    fetchCaptionVtt: async () => null,
  };
});

const route = async (name) => (await import(`../../pages/api/admin/${name}`)).default;
const ADMIN_DIR = path.join(process.cwd(), "pages/api/admin");

const ALL_BUT_OWNER = [
  "analytics.read", "audit.read", "broadcast.send", "comments.manage", "groups.manage",
  "roles.manage", "settings.manage", "shares.manage", "shares.read", "videos.manage",
  "videos.read", "videos.upload", "viewers.manage", "viewers.read",
];

function seed() {
  const groups = mem.hash("fablevideo:groups");
  const g = (id, name, restricted, videoIds) =>
    groups.set(id, { name, restricted, videoIds, collectionIds: [] });
  g("youth", "Youth", true, ["v1", "v3"]);
  g("deck", "Deck", true, ["v2", "v3"]);
  g("open", "Open", false, []);
  const viewers = mem.hash("fablevideo:viewers");
  viewers.set("y1@x.com", { addedAt: "2026-01-01", tags: ["Youth"] });
  viewers.set("d1@x.com", { addedAt: "2026-01-01", tags: ["Deck"] });
  viewers.set("both@x.com", { addedAt: "2026-01-01", tags: ["Deck", "Youth"] });
  viewers.set("free@x.com", { addedAt: "2026-01-01", tags: [] });
  mem.hash("fablevideo:roles").set("all", { id: "all", name: "Everything", capabilities: ALL_BUT_OWNER });
  mem.hash("fablevideo:user:roles").set("s@x.com", ["all"]);
  mem.hash("fablevideo:user:roles").set("u@x.com", ["all"]);
  mem.hash("fablevideo:user:scope").set("s@x.com", JSON.stringify(["youth"]));
}

const as = (email) => {
  state.email = email;
};

beforeEach(() => {
  mem.reset();
  state.deleted = [];
  state.created = [];
  state.updated = [];
  process.env.ADMIN_EMAILS = "owner@x.com";
  seed();
  as("s@x.com");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("every admin route is scope-aware (static)", () => {
  // A route either gates only on portal-wide capabilities — which a scoped
  // caller never holds — or handles the scope itself. A new route that does
  // neither fails here, before it can leak.
  const GLOBAL_ONLY = [
    "app-icon.js", "audit.js", "cleanup.js", "notify.js", "public-videos.js",
    "rating-recount.js", "roles.js", "settings.js",
  ];
  const files = fs.readdirSync(ADMIN_DIR).filter((f) => f.endsWith(".js"));
  it.each(files)("%s", (file) => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, file), "utf8");
    if (GLOBAL_ONLY.includes(file)) {
      const caps = [...src.matchAll(/CAP\.([A-Z_]+)/g)].map((m) => m[1]);
      expect(caps.every((c) => ["SETTINGS_MANAGE", "ROLES_MANAGE", "AUDIT_READ", "BROADCAST_SEND", "VIEWERS_MANAGE"].includes(c))).toBe(true);
      return;
    }
    expect(src, `${file} neither is portal-wide nor checks a staff scope`).toMatch(/staffScope(Rules)?"/);
  });
});

describe("portal-wide capabilities are gone under a scope", () => {
  it.each(["settings", "audit", "roles", "notify", "cleanup", "public-videos", "app-icon", "rating-recount"])(
    "%s answers 403",
    async (name) => {
      const res = await callRoute(await route(name), { method: "GET" });
      expect(res.statusCode).toBe(403);
    }
  );

  it("still answers the same routes for the unscoped holder of the same role", async () => {
    as("u@x.com");
    expect((await callRoute(await route("audit"), { method: "GET" })).statusCode).toBe(200);
  });
});

describe("videos", () => {
  it("lists only the scope's videos, and only its groups for scheduling", async () => {
    const res = await callRoute(await route("videos"), { method: "GET" });
    expect(res.body.videos.map((v) => v.id).sort()).toEqual(["v1", "v3"]);
    expect(res.body.groups.map((g) => g.id)).toEqual(["youth"]);
  });

  it("edits in-scope videos and answers 404 for the rest", async () => {
    const videos = await route("videos");
    const rename = (id) => callRoute(videos, { method: "POST", body: { action: "rename", id, title: "New" } });
    expect((await rename("v1")).statusCode).toBe(200);
    expect((await rename("v2")).statusCode).toBe(404);
    expect((await rename("v4")).statusCode).toBe(404);
  });

  it("deletes a video only its own groups can see", async () => {
    const videos = await route("videos");
    expect((await callRoute(videos, { method: "DELETE", query: { id: "v3" } })).statusCode).toBe(403);
    expect((await callRoute(videos, { method: "DELETE", query: { id: "v2" } })).statusCode).toBe(404);
    expect((await callRoute(videos, { method: "DELETE", query: { id: "v1" } })).statusCode).toBe(200);
    expect(state.deleted).toEqual(["v1"]);
  });

  it("holds bulk delete to the same rule, video by video", async () => {
    const res = await callRoute(await route("videos"), {
      method: "POST",
      body: { action: "bulk-delete", ids: ["v1", "v2", "v3"] },
    });
    expect(res.body.results.v1.ok).toBe(true);
    expect(res.body.results.v2.ok).toBe(false);
    expect(res.body.results.v3.ok).toBe(false);
    expect(state.deleted).toEqual(["v1"]);
  });

  it("refuses the library-wide acts: collections, the homepage order", async () => {
    const videos = await route("videos");
    expect(
      (await callRoute(videos, { method: "POST", body: { action: "set-collection", id: "v1", collectionId: "c" } }))
        .statusCode
    ).toBe(403);
    expect(
      (await callRoute(videos, { method: "POST", body: { action: "bulk-set-collection", ids: ["v1"], collectionId: "c" } }))
        .statusCode
    ).toBe(403);
    expect((await callRoute(await route("order"), { method: "POST", body: { order: ["v1"] } })).statusCode).toBe(403);
    expect((await callRoute(await route("collections"), { method: "POST", body: { name: "X" } })).statusCode).toBe(403);
    expect(state.updated).toEqual([]);
  });

  it("shows only its own videos' places in the homepage order", async () => {
    mem.strings.set("fablevideo:order", ["v4", "v3", "v2", "v1"]);
    const res = await callRoute(await route("order"), { method: "GET" });
    expect(res.body.order).toEqual(["v3", "v1"]);
  });

  it("sets per-group windows for its own groups only", async () => {
    const videos = await route("videos");
    const window = { publishAt: "2026-10-01T00:00:00.000Z", expiresAt: null };
    const set = (groups) =>
      callRoute(videos, { method: "POST", body: { action: "set-schedule", id: "v1", groups } });
    expect((await set({ youth: window })).statusCode).toBe(200);
    expect((await set({ youth: window, deck: window })).statusCode).toBe(403);
  });

  it("transcribes in-scope videos only", async () => {
    const transcribe = await route("transcribe");
    expect((await callRoute(transcribe, { method: "POST", body: { guid: "v2" } })).statusCode).toBe(404);
    expect((await callRoute(transcribe, { method: "POST", body: { guid: "v1" } })).statusCode).toBe(200);
  });
});

describe("uploads", () => {
  it("grants a new upload to the caller's groups, whether or not they chose", async () => {
    const res = await callRoute(await route("upload"), { method: "POST", body: { title: "Talk" } });
    expect(res.statusCode).toBe(201);
    expect(res.body.groups.granted).toEqual(["youth"]);
    expect(mem.hash("fablevideo:groups").get("youth").videoIds).toContain("new1");
  });

  it("refuses another group, or a collection, before the video exists", async () => {
    const upload = await route("upload");
    expect((await callRoute(upload, { method: "POST", body: { title: "T", groupIds: ["deck"] } })).statusCode).toBe(403);
    expect((await callRoute(upload, { method: "POST", body: { title: "T", collectionId: "c" } })).statusCode).toBe(403);
    expect(state.created).toEqual([]);
  });
});

describe("viewers", () => {
  it("lists only the scope's people", async () => {
    const res = await callRoute(await route("viewers"), { method: "GET" });
    expect(res.body.viewers.map((v) => v.email).sort()).toEqual(["both@x.com", "y1@x.com"]);
  });

  it("approves new people straight into their group, in the same record", async () => {
    const res = await callRoute(await route("viewers"), { method: "POST", body: { emails: "new@x.com" } });
    expect(res.body.added).toBe(1);
    expect(mem.hash("fablevideo:viewers").get("new@x.com").tags).toEqual(["Youth"]);
  });

  it("refuses to approve into a group that is not theirs", async () => {
    const res = await callRoute(await route("viewers"), {
      method: "POST",
      body: { emails: "new@x.com", group: "deck" },
    });
    expect(res.statusCode).toBe(400);
    expect(mem.hash("fablevideo:viewers").has("new@x.com")).toBe(false);
  });

  it("never takes someone out of their last restricted group", async () => {
    const viewers = await route("viewers");
    const patch = (email, tags) => callRoute(viewers, { method: "PATCH", body: { email, tags } });
    expect((await patch("y1@x.com", [])).statusCode).toBe(403);
    expect((await patch("both@x.com", ["Deck"])).statusCode).toBe(200);
    expect((await patch("d1@x.com", ["Deck", "Youth"])).statusCode).toBe(404);
  });

  it("removes only someone wholly inside the scope", async () => {
    const viewers = await route("viewers");
    const del = (email) => callRoute(viewers, { method: "DELETE", query: { email } });
    expect((await del("both@x.com")).statusCode).toBe(403);
    expect((await del("free@x.com")).statusCode).toBe(404);
    expect((await del("y1@x.com")).statusCode).toBe(200);
  });

  it("approves an access request into their group", async () => {
    mem.hash("fablevideo:requests").set("asker@x.com", {
      email: "asker@x.com",
      status: "pending",
      requestedAt: "2026-01-01",
    });
    const res = await callRoute(await route("access-requests"), {
      method: "POST",
      body: { email: "asker@x.com", decision: "approve" },
    });
    expect(res.statusCode).toBe(200);
    expect(mem.hash("fablevideo:viewers").get("asker@x.com").tags).toEqual(["Youth"]);
  });
});

describe("groups", () => {
  it("shows only their groups, and never the group record controls", async () => {
    const res = await callRoute(await route("groups"), { method: "GET" });
    expect(res.body.groups.map((g) => g.id)).toEqual(["youth"]);
    expect(res.body.canEditGroups).toBe(false);
    expect(res.body.untrackedTags).toEqual([]);
  });

  it("refuses to change a group record or delete a group", async () => {
    const groups = await route("groups");
    expect((await callRoute(groups, { method: "PUT", body: { name: "Youth", videoIds: ["v2"] } })).statusCode).toBe(403);
    expect((await callRoute(groups, { method: "DELETE", query: { name: "Youth" } })).statusCode).toBe(403);
    expect(mem.hash("fablevideo:groups").get("youth").videoIds).toEqual(["v1", "v3"]);
  });

  it("adds only people already in scope, and reports others like strangers", async () => {
    const res = await callRoute(await route("groups"), {
      method: "PATCH",
      body: { name: "Youth", add: ["d1@x.com", "free@x.com", "nobody@x.com"] },
    });
    expect(res.body.added).toEqual([]);
    expect(res.body.unknown).toEqual(["d1@x.com", "free@x.com", "nobody@x.com"]);
    expect(mem.hash("fablevideo:viewers").get("free@x.com").tags).toEqual([]);
  });

  it("keeps someone whose last restricted group this is", async () => {
    const res = await callRoute(await route("groups"), {
      method: "PATCH",
      body: { name: "Youth", remove: ["y1@x.com", "both@x.com"] },
    });
    expect(res.body.refused).toEqual(["y1@x.com"]);
    expect(res.body.removed).toEqual(["both@x.com"]);
    expect(mem.hash("fablevideo:viewers").get("y1@x.com").tags).toEqual(["Youth"]);
  });

  it("answers 404 for someone else's group", async () => {
    const res = await callRoute(await route("groups"), { method: "PATCH", body: { name: "Deck", add: ["y1@x.com"] } });
    expect(res.statusCode).toBe(404);
  });
});

describe("shares and analytics", () => {
  it("shares in-scope videos only", async () => {
    const share = await route("share");
    const make = (videoId) =>
      callRoute(share, { method: "POST", body: { videoId, email: "guest@x.com", sendEmail: false } });
    expect((await make("v2")).statusCode).toBe(404);
    expect((await make("v1")).statusCode).toBe(201);
  });

  it("lists and revokes only links to in-scope videos", async () => {
    const shares = mem.hash("fablevideo:shares");
    const link = (videoId) => ({ videoId, videoTitle: videoId, email: "g@x.com", expiresAt: "2099-01-01T00:00:00.000Z" });
    shares.set("aaaaaaaaaaaaaaaa1", link("v1"));
    shares.set("aaaaaaaaaaaaaaaa2", link("v2"));
    const sharesRoute = await route("shares");
    const list = await callRoute(sharesRoute, { method: "GET", headers: { host: "x" } });
    expect(list.body.shares.map((s) => s.videoId)).toEqual(["v1"]);
    const revoke = await callRoute(sharesRoute, { method: "DELETE", query: { id: "aaaaaaaaaaaaaaaa2" } });
    expect(revoke.statusCode).toBe(404);
    expect(shares.get("aaaaaaaaaaaaaaaa2").revoked).toBeUndefined();
  });

  it("counts only in-scope videos, and leaves out the library-wide chart", async () => {
    const res = await callRoute(await route("analytics"), { method: "GET" });
    expect(res.body.videoCount).toBe(2);
    expect(res.body.totalViews).toBe(6);
    expect(res.body.libraryWide).toBe(false);
    expect(res.body.chart).toEqual([]);
  });
});

describe("the scope itself", () => {
  const assign = (body) => callRoute(rolesRoute, { method: "PATCH", body });
  let rolesRoute;
  beforeEach(async () => {
    rolesRoute = await route("roles");
    as("owner@x.com");
  });

  it("is set and lifted through the Roles route, by an owner", async () => {
    expect((await assign({ email: "u@x.com", roleIds: ["all"], scope: ["deck"] })).statusCode).toBe(200);
    expect(JSON.parse(mem.hash("fablevideo:user:scope").get("u@x.com"))).toEqual(["deck"]);
    expect((await assign({ email: "u@x.com", roleIds: ["all"], scope: null })).statusCode).toBe(200);
    expect(mem.hash("fablevideo:user:scope").has("u@x.com")).toBe(false);
  });

  it("names only restricted groups, and never limits an owner", async () => {
    expect((await assign({ email: "u@x.com", roleIds: ["all"], scope: ["open"] })).statusCode).toBe(400);
    expect((await assign({ email: "owner@x.com", roleIds: [], scope: ["deck"] })).statusCode).toBe(400);
  });

  it("goes with the last role", async () => {
    await assign({ email: "s@x.com", roleIds: [] });
    expect(mem.hash("fablevideo:user:scope").has("s@x.com")).toBe(false);
  });

  it("is out of reach of the scoped person themselves", async () => {
    as("s@x.com");
    expect((await assign({ email: "s@x.com", roleIds: ["all"], scope: null })).statusCode).toBe(403);
  });
});

describe("another viewer's progress", () => {
  it("is readable only for the scope's people", async () => {
    const progress = (await import("../../pages/api/progress")).default;
    const read = (email) => callRoute(progress, { method: "GET", query: { email } });
    expect((await read("d1@x.com")).statusCode).toBe(404);
    expect((await read("y1@x.com")).statusCode).toBe(200);
  });
});
