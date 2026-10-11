// Removing a viewer deletes what was recorded about them (lib/viewerData.js),
// through the real route: their votes come back out of the totals, their
// progress and saved list go, and so do their comments on every video —
// nobody else's. The data goes BEFORE their access, so a failure leaves them
// listed and the removal can simply be tried again.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mem } from "./helpers/memoryRedis";
import { callRoute } from "./helpers/route";

const state = vi.hoisted(() => ({ email: "owner@x.com" }));

vi.mock("../redis", async () => (await import("./helpers/memoryRedis")).redisModule);
vi.mock("../auth0", () => ({
  auth0: { getSession: async () => (state.email ? { user: { email: state.email } } : null) },
}));
vi.mock("../ratelimit", () => ({ allowRequest: async () => true }));

const route = (await import("../../pages/api/admin/viewers")).default;
const remove = (email) => callRoute(route, { method: "DELETE", query: { email } });
const comment = (videoId, id, email) =>
  mem.hash(`fablevideo:comments:${videoId}`).set(id, { id, email, name: "N", text: "hi", at: 1 });
const counts = () => Object.fromEntries(mem.hash("fablevideo:rating_counts"));

function seed(email) {
  mem.hash("fablevideo:viewers").set(email, { addedAt: "2026-01-01", tags: [] });
  mem.hash(`fablevideo:progress:${email}`).set("v1", { seconds: 30 });
  mem.hash(`fablevideo:mylist:${email}`).set("v1", 1);
  mem.hash(`fablevideo:ratings:${email}`).set("v1", "up");
  mem.hash(`fablevideo:ratings:${email}`).set("v2", "down");
}

beforeEach(() => {
  mem.reset();
  process.env.ADMIN_EMAILS = "owner@x.com";
  state.email = "owner@x.com";
  seed("gone@x.com");
  seed("stays@x.com");
  mem.hash("fablevideo:rating_counts").set("v1:up", 2);
  mem.hash("fablevideo:rating_counts").set("v2:down", 2);
  comment("v1", "caaaaaaa1", "gone@x.com");
  comment("v1", "caaaaaaa2", "stays@x.com");
  comment("v2", "caaaaaaa3", "Gone@X.com");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("removing a viewer", () => {
  it("deletes their votes from the totals, their progress, saved list and comments", async () => {
    const res = await remove("gone@x.com");
    expect(res.statusCode).toBe(200);
    expect(res.body.forgotten).toEqual({ votes: 2, comments: 2 });
    expect(counts()).toEqual({ "v1:up": 1, "v2:down": 1 });
    for (const family of ["progress", "mylist", "ratings"]) {
      expect(mem.hashes.has(`fablevideo:${family}:gone@x.com`), family).toBe(false);
    }
    expect([...mem.hash("fablevideo:comments:v1").keys()]).toEqual(["caaaaaaa2"]);
    expect(mem.hash("fablevideo:comments:v2").size).toBe(0);
    expect(mem.hash("fablevideo:viewers").has("gone@x.com")).toBe(false);
  });

  it("leaves everyone else’s data alone", async () => {
    await remove("gone@x.com");
    expect(mem.hash("fablevideo:progress:stays@x.com").size).toBe(1);
    expect(mem.hash("fablevideo:mylist:stays@x.com").size).toBe(1);
    expect(mem.hash("fablevideo:ratings:stays@x.com").size).toBe(2);
  });

  it("keeps them listed when their data cannot be deleted, so it can be retried", async () => {
    const realHash = mem.hash.bind(mem);
    vi.spyOn(mem, "hash").mockImplementation((key) => {
      if (key.startsWith("fablevideo:comments:")) throw new Error("redis down");
      return realHash(key);
    });
    const res = await remove("gone@x.com");
    expect(res.statusCode).toBe(502);
    vi.restoreAllMocks();
    expect(mem.hash("fablevideo:viewers").has("gone@x.com")).toBe(true);
    expect((await remove("gone@x.com")).statusCode).toBe(200);
    expect(mem.hash("fablevideo:comments:v1").has("caaaaaaa1")).toBe(false);
  });

  it("never deletes an owner’s data, since removing them does not remove their access", async () => {
    state.email = "u@x.com";
    mem.hash("fablevideo:roles").set("people", { id: "people", name: "People", capabilities: ["viewers.manage", "viewers.read"] });
    mem.hash("fablevideo:user:roles").set("u@x.com", ["people"]);
    seed("owner@x.com");
    const res = await remove("owner@x.com");
    expect(res.statusCode).toBe(200);
    expect(res.body.forgotten).toBeNull();
    expect(mem.hash("fablevideo:progress:owner@x.com").size).toBe(1);
  });
});
