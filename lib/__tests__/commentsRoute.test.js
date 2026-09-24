// pages/api/comments.js — who may read, write and delete comments.
//
// Gated like watching: group scope for everything, the publish window for
// reading and writing. The author is always the SESSION; other viewers never
// see an email; deleting someone else's comment needs comments.manage and is
// audited.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

let access = null;
let inScope = true;
let live = true;
let allowed = true;
let profileName = "Jane Smith";
let store = {};
let full = false;
const audit = [];

vi.mock("../guard", () => ({
  requireAccess: async (req, res) => {
    if (!access) {
      res.status(401).json({ error: "Login required" });
      return null;
    }
    return access;
  },
}));
vi.mock("../roles", () => ({ scopeAllows: () => inScope }));
vi.mock("../schedule", () => ({ viewerMayActOn: async (a) => a.staff || live }));
vi.mock("../ratelimit", () => ({ allowRequest: async () => allowed }));
vi.mock("../audit", () => ({ logAction: async (...a) => audit.push(a) }));
vi.mock("../auth0", () => ({ auth0: { getSession: async () => ({ user: { name: profileName } }) } }));
vi.mock("../commentsStore", async () => {
  const { parseComment, sortComments } = await vi.importActual("../comments");
  let n = 0;
  return {
    listComments: async (videoId) => sortComments(Object.values(store[videoId] || {}).map(parseComment)),
    getComment: async (videoId, id) => (store[videoId]?.[id] ? parseComment(store[videoId][id]) : null),
    addComment: async (videoId, { email, name, text }) => {
      if (full) return { ok: false, error: "full" };
      n += 1;
      const comment = { id: `cnew${String(n).padStart(4, "0")}`, email, name, text, at: 1000 + n };
      store[videoId] = { ...(store[videoId] || {}), [comment.id]: comment };
      return { ok: true, comment: parseComment(comment) };
    },
    deleteComment: async (videoId, id) => {
      delete store[videoId]?.[id];
    },
  };
});

const route = (await import("../../pages/api/comments")).default;

const viewer = (email, capabilities = [], staff = false) => ({ email, capabilities, staff, videoScope: null });
const get = (videoId = "vid-1") => callRoute(route, { method: "GET", query: { videoId } });
const post = (body) => callRoute(route, { method: "POST", body: { videoId: "vid-1", ...body } });
const del = (id, videoId = "vid-1") => callRoute(route, { method: "DELETE", query: { videoId, id } });

const janes = { id: "cjane0001", email: "jane@example.com", name: "Jane Smith", text: "Amen", at: 1 };

beforeEach(() => {
  access = viewer("bob@example.com");
  inScope = true;
  live = true;
  allowed = true;
  profileName = "Bob Jones";
  store = { "vid-1": { [janes.id]: { ...janes } } };
  full = false;
  audit.length = 0;
});

describe("the gate", () => {
  it("refuses a caller without access", async () => {
    access = null;
    expect((await get()).statusCode).toBe(401);
  });

  it.each(["GET", "POST", "DELETE"])("404s a %s on a video outside the caller's groups", async (method) => {
    inScope = false;
    const res = await callRoute(route, {
      method,
      query: { videoId: "vid-1", id: janes.id },
      body: { videoId: "vid-1", text: "hi" },
    });
    expect(res.statusCode).toBe(404);
    expect(store["vid-1"][janes.id]).toBeDefined();
  });

  it("404s reading or writing outside the publish window", async () => {
    live = false;
    expect((await get()).statusCode).toBe(404);
    expect((await post({ text: "early" })).statusCode).toBe(404);
    expect(Object.keys(store["vid-1"])).toEqual([janes.id]);
  });

  it("lets staff read and write outside the window", async () => {
    live = false;
    access = viewer("admin@example.com", ["videos.manage"], true);
    expect((await get()).statusCode).toBe(200);
    expect((await post({ text: "preview note" })).statusCode).toBe(200);
  });

  it("rejects other methods", async () => {
    expect((await callRoute(route, { method: "PUT", query: { videoId: "vid-1" } })).statusCode).toBe(405);
  });

  it("needs a video id", async () => {
    expect((await get("")).statusCode).toBe(400);
  });
});

describe("reading", () => {
  it("shows names and never emails to an ordinary viewer", async () => {
    const res = await get();
    expect(res.body.comments).toEqual([
      { id: janes.id, name: "Jane Smith", text: "Amen", at: 1, mine: false, canDelete: false },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("jane@example.com");
  });

  it("shows the email to a caller who may read the viewer list", async () => {
    access = viewer("admin@example.com", ["viewers.read"], true);
    expect((await get()).body.comments[0].email).toBe("jane@example.com");
  });
});

describe("writing", () => {
  it("posts as the session's person, under their profile name", async () => {
    const res = await post({ text: "  Thank you  ", email: "jane@example.com", name: "Jane Smith" });
    expect(res.statusCode).toBe(200);
    expect(res.body.comment).toMatchObject({ name: "Bob Jones", text: "Thank you", mine: true });
    const stored = Object.values(store["vid-1"]).find((c) => c.text === "Thank you");
    expect(stored.email).toBe("bob@example.com");
  });

  it("never shows an email-shaped profile name", async () => {
    profileName = "bob@example.com";
    expect((await post({ text: "hello" })).body.comment.name).toBe("bob");
  });

  it("refuses an empty or oversized comment", async () => {
    expect((await post({ text: "   " })).statusCode).toBe(400);
    expect((await post({ text: "x".repeat(1001) })).statusCode).toBe(400);
  });

  it("says so when the video is at its comment limit", async () => {
    full = true;
    expect((await post({ text: "one more" })).statusCode).toBe(409);
  });

  it("is rate limited", async () => {
    allowed = false;
    expect((await post({ text: "spam" })).statusCode).toBe(429);
  });
});

describe("deleting", () => {
  it("lets an author delete their own comment, unaudited", async () => {
    access = viewer("jane@example.com");
    expect((await del(janes.id)).statusCode).toBe(200);
    expect(store["vid-1"][janes.id]).toBeUndefined();
    expect(audit).toEqual([]);
  });

  it("lets an author delete their own comment even after the video is taken down", async () => {
    access = viewer("jane@example.com");
    live = false;
    expect((await del(janes.id)).statusCode).toBe(200);
  });

  it("refuses to delete someone else's comment without comments.manage", async () => {
    access = viewer("bob@example.com", ["videos.manage", "viewers.manage"], true);
    expect((await del(janes.id)).statusCode).toBe(403);
    expect(store["vid-1"][janes.id]).toBeDefined();
  });

  it("lets a moderator remove anyone's comment, and audits it", async () => {
    access = viewer("mod@example.com", ["comments.manage"], true);
    expect((await del(janes.id)).statusCode).toBe(200);
    expect(store["vid-1"][janes.id]).toBeUndefined();
    expect(audit).toEqual([["mod@example.com", "comment.delete", "vid-1: a comment by Jane Smith"]]);
  });

  it("404s a comment that does not exist, or belongs to another video", async () => {
    access = viewer("jane@example.com");
    expect((await del("cmissing01")).statusCode).toBe(404);
    expect((await del(janes.id, "vid-2")).statusCode).toBe(404);
  });
});
