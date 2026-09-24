// GET /api/cron/transcripts — the scheduled transcript collector, and
// lib/cronAuth.js, the only thing guarding it.
//
// The route has no session and is excluded from proxy.js, so the secret check
// IS the access control. The tests below are mostly about refusing: no secret
// configured, a short one, a wrong one, a missing header, the wrong method —
// each must answer without the collector ever running.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

const collect = vi.fn();
const audit = [];
vi.mock("../transcriptCollect", () => ({ collectFinishedTranscripts: (...a) => collect(...a) }));
vi.mock("../audit", () => ({ logAction: async (...a) => audit.push(a) }));
vi.mock("../auth0", () => ({ auth0: { middleware: async () => null, getSession: async () => null } }));

const route = (await import("../../pages/api/cron/transcripts")).default;
const { cronSecret, isCronAuthorized, MIN_CRON_SECRET_LENGTH } = await import("../cronAuth");
const { MAX_COLLECT_PER_SCHEDULED_RUN } = await import("../transcribeQueue");

const SECRET = "s3cret-value-long-enough-0123";
const bearer = (s = SECRET) => ({ authorization: `Bearer ${s}` });

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  collect.mockReset().mockResolvedValue({ collected: [], expired: [], busy: false });
  audit.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("cronAuth", () => {
  it("accepts exactly `Bearer <secret>`", () => {
    expect(isCronAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([
    ["a wrong secret", `Bearer ${SECRET}x`],
    ["the secret without Bearer", SECRET],
    ["a different scheme", `Basic ${SECRET}`],
    ["an empty header", ""],
    ["no header", undefined],
    ["a repeated header", [`Bearer ${SECRET}`]],
  ])("refuses %s", (_why, header) => {
    expect(isCronAuthorized(header, SECRET)).toBe(false);
  });

  it("refuses everything when there is no secret, even an empty bearer", () => {
    expect(isCronAuthorized("Bearer ", "")).toBe(false);
    expect(isCronAuthorized("Bearer null", null)).toBe(false);
  });

  it("treats a missing or short secret as not configured", () => {
    expect(cronSecret({})).toBeNull();
    expect(cronSecret({ CRON_SECRET: "x".repeat(MIN_CRON_SECRET_LENGTH - 1) })).toBeNull();
    expect(cronSecret({ CRON_SECRET: SECRET })).toBe(SECRET);
    expect(cronSecret({ CRON_SECRET: ` ${SECRET}\n` })).toBe(SECRET);
    expect(cronSecret({ CRON_SECRET: "   " })).toBeNull();
  });
});

describe("GET /api/cron/transcripts — refusing", () => {
  it("does not exist until CRON_SECRET is set", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await callRoute(route, { headers: bearer("") });
    expect(res.statusCode).toBe(404);
    expect(collect).not.toHaveBeenCalled();
  });

  it("does not exist with a secret too short to trust", async () => {
    vi.stubEnv("CRON_SECRET", "short");
    const res = await callRoute(route, { headers: bearer("short") });
    expect(res.statusCode).toBe(404);
    expect(collect).not.toHaveBeenCalled();
  });

  it.each([
    ["no Authorization header", {}],
    ["a wrong secret", bearer("not-the-secret-at-all-000")],
  ])("401s with %s, collecting nothing", async (_why, headers) => {
    const res = await callRoute(route, { headers });
    expect(res.statusCode).toBe(401);
    expect(collect).not.toHaveBeenCalled();
  });

  it("405s anything but GET, collecting nothing", async () => {
    const res = await callRoute(route, { method: "POST", headers: bearer() });
    expect(res.statusCode).toBe(405);
    expect(collect).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/transcripts — running", () => {
  it("collects with the scheduled-run cap and audits each video", async () => {
    collect.mockResolvedValue({
      collected: [
        { guid: "v1", language: "en", cues: 40 },
        { guid: "v2", language: "es", cues: 12 },
      ],
      expired: ["old"],
      busy: false,
    });
    const res = await callRoute(route, { headers: bearer() });
    expect(res.statusCode).toBe(200);
    expect(collect).toHaveBeenCalledWith({ limit: MAX_COLLECT_PER_SCHEDULED_RUN });
    expect(res.body).toEqual({ ok: true, collected: 2, expired: 1, busy: false });
    expect(audit.map(([actor, action, detail]) => [actor, action, detail.split(" ")[0]])).toEqual([
      ["scheduled job", "video.transcript_ingest", "v1"],
      ["scheduled job", "video.transcript_ingest", "v2"],
    ]);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("reports a run skipped because another held the lock", async () => {
    collect.mockResolvedValue({ collected: [], expired: [], busy: true });
    const res = await callRoute(route, { headers: bearer() });
    expect(res.body).toEqual({ ok: true, collected: 0, expired: 0, busy: true });
  });

  it("500s when collection throws, so the cron log shows a failure", async () => {
    collect.mockRejectedValue(new Error("redis down"));
    const res = await callRoute(route, { headers: bearer() });
    expect(res.statusCode).toBe(500);
  });
});

describe("proxy.js leaves scheduled jobs alone", () => {
  // Geo enforcement would refuse Vercel's cron runner (its requests may carry
  // no country), so the route must never pass through proxy.js. Read the
  // matcher as Next does — one anchored pattern — and check which paths it
  // would send through the proxy.
  it("excludes /api/cron/*, and only that", async () => {
    const { config } = await import("../../proxy");
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    expect(matcher.test("/api/cron/transcripts")).toBe(false);
    for (const path of ["/", "/admin", "/api/videos", "/api/crontab", "/api/cronjobs"]) {
      expect(matcher.test(path), path).toBe(true);
    }
  });
});
