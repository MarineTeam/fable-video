// pages/api/admin/notify.js — the click target of an admin broadcast.
//
// The route's stated contract is "only allow same-origin paths as the click
// target — never an external URL", and it used to enforce that with
// `rawUrl.startsWith("/")`. That is not the same test: "//evil.com" starts
// with "/" and is a protocol-relative URL that resolves to another origin, as
// does the backslash form browsers normalise. public/sw.js takes this value
// and calls `client.navigate(target)` on an already-open portal tab, so the
// gap pointed every approved viewer's tab wherever a broadcaster liked.
//
// These pin the corrected check. They are deliberately about the URL only —
// the delivery machinery is mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

const sendPushToApproved = vi.fn(async () => ({ sent: 1, failed: 0 }));

vi.mock("../guard", () => ({
  requireCapability: async () => ({ email: "admin@example.com" }),
}));
vi.mock("../ratelimit", () => ({ allowRequest: async () => true }));
vi.mock("../audit", () => ({ logAction: async () => {} }));
vi.mock("../push", () => ({
  pushEnabled: () => true,
  sendPushToApproved: (...args) => sendPushToApproved(...args),
}));

const notify = (await import("../../pages/api/admin/notify")).default;

async function broadcastWith(url) {
  sendPushToApproved.mockClear();
  const res = await callRoute(notify, {
    method: "POST",
    body: { title: "Service tonight", body: "Starts at 7", url },
  });
  return { res, sent: sendPushToApproved.mock.calls[0]?.[0] };
}

// Resolved against a real origin, because that is what the browser does with
// whatever the service worker hands to client.navigate().
const originOf = (path) => new URL(path, "https://portal.example").origin;

describe("admin broadcast click target", () => {
  beforeEach(() => sendPushToApproved.mockClear());

  it("keeps an ordinary same-origin path", async () => {
    for (const path of ["/", "/admin", "/watch/abc?t=30"]) {
      const { sent } = await broadcastWith(path);
      expect(sent.url).toBe(path);
    }
  });

  // The regression. Each of these passes the old startsWith("/") test.
  it("rejects a protocol-relative URL that startsWith('/') accepted", async () => {
    for (const hostile of ["//evil.com", "//evil.com/phish", "/\\evil.com"]) {
      expect(hostile.startsWith("/")).toBe(true); // the old guard said yes
      expect(originOf(hostile)).toBe("https://evil.com"); // and it was external

      const { sent } = await broadcastWith(hostile);
      expect(sent.url).toBe("/");
      expect(originOf(sent.url)).toBe("https://portal.example");
    }
  });

  it("still rejects an absolute URL", async () => {
    const { sent } = await broadcastWith("https://evil.com");
    expect(sent.url).toBe("/");
  });

  // A wrong-typed url is not coerced into a plausible path: String(['/a','/b'])
  // would have been "/a,/b", a target nobody sent.
  it("falls back to / for a wrong-typed url", async () => {
    for (const wrong of [["/a", "/b"], ["//evil.com"], 5, true, { a: 1 }]) {
      const { sent } = await broadcastWith(wrong);
      expect(sent.url).toBe("/");
    }
  });
});
