import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";

// Each test imports fresh so module-load-time reads of process.env are
// picked up by that test's setup.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@upstash/redis");
});

describe("monitorEnabled", () => {
  // The panel once rendered against a server that wasn't instrumented at
  // all, sitting at a frozen zero, because the flag was matched with a
  // strict === "true". A value pasted into Vercel arrives as "true " or
  // "True" easily.
  it("accepts truthy spellings, surrounding whitespace and casing", async () => {
    for (const raw of ["true", "true ", " true", "True", "TRUE", "1", "on", "yes", " YES "]) {
      process.env.QUERY_MONITOR_ENABLED = raw;
      vi.resetModules();
      const { monitorEnabled } = await import("../monitor");
      expect(monitorEnabled(), `expected ${JSON.stringify(raw)} to enable`).toBe(true);
    }
  });

  it("stays off when unset or falsey", async () => {
    for (const raw of [undefined, "", " ", "false", "off", "0", "no"]) {
      if (raw === undefined) delete process.env.QUERY_MONITOR_ENABLED;
      else process.env.QUERY_MONITOR_ENABLED = raw;
      vi.resetModules();
      const { monitorEnabled } = await import("../monitor");
      expect(monitorEnabled(), `expected ${JSON.stringify(raw)} to stay off`).toBe(false);
    }
  });
});

describe("withMonitorPage", () => {
  it("attributes queries and external calls to the request", async () => {
    process.env.QUERY_MONITOR_ENABLED = "true";
    const { withMonitorPage, recordQuery, recordExternal } = await import("../monitor");

    const gssp = withMonitorPage(async () => {
      recordQuery("get", 5);
      recordQuery("hgetall", 7);
      recordExternal("bunny /videos", 40);
      return { props: { hello: "world" } };
    });

    const { props } = await gssp({});
    expect(props.hello).toBe("world");
    expect(props._monitor.queryCount).toBe(2);
    expect(props._monitor.queryMs).toBe(12);
    expect(props._monitor.externalCount).toBe(1);
    expect(props._monitor.externalMs).toBe(40);
    expect(props._monitor.queries.map((q) => q.command)).toEqual(["get", "hgetall"]);
  });

  it("is a no-op when disabled, and leaves redirects/notFound alone when enabled", async () => {
    process.env.QUERY_MONITOR_ENABLED = "false";
    let mod = await import("../monitor");
    let out = await mod.withMonitorPage(async () => ({ props: {} }))({});
    expect(out.props._monitor).toBeUndefined();

    process.env.QUERY_MONITOR_ENABLED = "true";
    vi.resetModules();
    mod = await import("../monitor");

    const redirect = { redirect: { destination: "/", permanent: false } };
    expect(await mod.withMonitorPage(async () => redirect)({})).toEqual(redirect);

    const notFound = { notFound: true };
    expect(await mod.withMonitorPage(async () => notFound)({})).toEqual(notFound);
  });

  // Plenty of Redis/bunny calls happen from fire-and-forget paths (e.g.
  // lib/audit.js's best-effort logging) with no surrounding request context.
  it("ignores records made outside a request context", async () => {
    process.env.QUERY_MONITOR_ENABLED = "true";
    const { recordQuery, recordExternal } = await import("../monitor");
    expect(() => recordQuery("get", 1)).not.toThrow();
    expect(() => recordExternal("bunny /videos", 1)).not.toThrow();
  });
});

function fakeApiRes() {
  const headers = {};
  return {
    headersSent: false,
    setHeader: (name, value) => {
      headers[name] = value;
    },
    json: (body) => body,
    end: (...args) => args,
    _headers: headers,
  };
}

describe("withMonitorApi", () => {
  it("attaches aggregates only (not per-query detail) as the X-Query-Monitor header", async () => {
    process.env.QUERY_MONITOR_ENABLED = "true";
    const { withMonitorApi, recordQuery, recordExternal } = await import("../monitor");
    const res = fakeApiRes();

    const handler = withMonitorApi(async (req, r) => {
      recordQuery("get", 3);
      recordExternal("bunny /videos", 8);
      return r.json({ ok: true });
    });
    const result = await handler({}, res);
    expect(result).toEqual({ ok: true });

    const stats = JSON.parse(res._headers["X-Query-Monitor"]);
    expect(stats.queryCount).toBe(1);
    expect(stats.queryMs).toBe(3);
    expect(stats.externalCount).toBe(1);
    expect(stats.externalMs).toBe(8);
    // Headers have platform size limits — per-command detail belongs only in
    // getServerSideProps props, which have no practical ceiling.
    expect(stats.queries).toBeUndefined();
    expect(stats.external).toBeUndefined();
  });

  it("is a no-op when disabled: handler runs unwrapped and no header is set", async () => {
    process.env.QUERY_MONITOR_ENABLED = "false";
    const { withMonitorApi } = await import("../monitor");
    const res = fakeApiRes();
    const handler = withMonitorApi(async (req, r) => r.json({ ok: true }));
    await handler({}, res);
    expect(res._headers["X-Query-Monitor"]).toBeUndefined();
  });
});

describe("lib/redis.js instrumentation", () => {
  it("times every Redis command via the Proxy without changing its behavior", async () => {
    process.env.QUERY_MONITOR_ENABLED = "true";
    process.env.KV_REST_API_URL = "https://example.upstash.io";
    process.env.KV_REST_API_TOKEN = "test-token";

    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        async get(key) {
          return `value:${key}`;
        }
      },
    }));

    const { withMonitorPage } = await import("../monitor");
    const { redis } = await import("../redis");

    const gssp = withMonitorPage(async () => {
      const value = await redis().get("k1");
      return { props: { value } };
    });
    const { props } = await gssp({});

    expect(props.value).toBe("value:k1");
    expect(props._monitor.queryCount).toBe(1);
    expect(props._monitor.queries[0].command).toBe("get");
  });

  it("is a pure pass-through when disabled", async () => {
    process.env.QUERY_MONITOR_ENABLED = "false";
    process.env.KV_REST_API_URL = "https://example.upstash.io";
    process.env.KV_REST_API_TOKEN = "test-token";

    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        async get(key) {
          return `value:${key}`;
        }
      },
    }));

    const { redis } = await import("../redis");
    expect(await redis().get("k1")).toBe("value:k1");
  });
});

describe("lib/bunny.js instrumentation", () => {
  // lib/bunny.js funnels every call through one internal `api()` helper;
  // timing it there covers every exported function with zero edits to the
  // signing functions below, which never call `api()`. These assertions pin
  // the two things that must not have changed: the byte-exact vendor
  // signing formulas, and the fact that a bunny call still returns its
  // payload untouched.
  const LIB = "12345";
  const KEY = "test-api-key";
  const TOKEN_KEY = "token-key";
  const GUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  beforeEach(() => {
    process.env.QUERY_MONITOR_ENABLED = "true";
    process.env.BUNNY_LIBRARY_ID = LIB;
    process.env.BUNNY_API_KEY = KEY;
    process.env.BUNNY_TOKEN_AUTH_KEY = TOKEN_KEY;
  });

  it("keeps signTusUpload byte-exact, with expiry in seconds", async () => {
    const { signTusUpload } = await import("../bunny");
    const { signature, expire, libraryId } = signTusUpload(GUID, { ttlSeconds: 3600 });
    expect(signature).toBe(
      crypto.createHash("sha256").update(`${LIB}${KEY}${expire}${GUID}`).digest("hex")
    );
    expect(libraryId).toBe(LIB);
    // seconds, not milliseconds — a 13-digit value here was a real 401 outage class
    expect(String(expire)).toHaveLength(10);
  });

  it("keeps signEmbedUrl byte-exact and embeds with autoplay=false", async () => {
    const { signEmbedUrl } = await import("../bunny");
    const url = signEmbedUrl(GUID, { ttlSeconds: 3600 });
    const parsed = new URL(url);
    const token = parsed.searchParams.get("token");
    const expires = parsed.searchParams.get("expires");
    expect(token).toBe(
      crypto.createHash("sha256").update(`${TOKEN_KEY}${GUID}${expires}`).digest("hex")
    );
    expect(url.endsWith("autoplay=false")).toBe(true);
  });

  it("times a bunny call as external and returns its payload unchanged", async () => {
    // Stubbed before importing lib/bunny — the module calls the global
    // `fetch` at call time (not capture time here), so no real network call
    // is made.
    const stub = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ items: [{ guid: GUID, title: "A" }] }),
    }));
    vi.stubGlobal("fetch", stub);

    const { withMonitorPage } = await import("../monitor");
    const { listVideos } = await import("../bunny");

    const gssp = withMonitorPage(async () => ({ props: { data: await listVideos() } }));
    const { props } = await gssp({});

    expect(stub).toHaveBeenCalledTimes(1);
    expect(props.data).toEqual({ items: [{ guid: GUID, title: "A" }] });
    expect(props._monitor.externalCount).toBe(1);
    expect(props._monitor.external[0].label).toBe("bunny /videos");
  });

  it("keeps ids out of the external call label", async () => {
    const stub = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ guid: GUID }),
    }));
    vi.stubGlobal("fetch", stub);

    const { withMonitorPage } = await import("../monitor");
    const { getVideo } = await import("../bunny");

    const gssp = withMonitorPage(async () => ({ props: { data: await getVideo(GUID) } }));
    const { props } = await gssp({});

    expect(props._monitor.external[0].label).toBe("bunny /videos");
    expect(props._monitor.external[0].label).not.toContain(GUID);
  });
});
