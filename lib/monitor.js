import { AsyncLocalStorage } from "async_hooks";

// Query Monitor / performance panel. Opt-in via the single env var
// QUERY_MONITOR_ENABLED; unset or falsey -> every helper here is a no-op,
// matching the resilience-by-degradation posture used elsewhere in this app
// (email, push, geo all follow the same "inert unless configured" shape).
//
// Deliberately ONE server-side var, not a server + NEXT_PUBLIC_ pair: the
// client learns whether the monitor is on at runtime from /api/monitor (see
// lib/monitorClient.js). A build-time client flag would let the panel render
// against a server that isn't instrumented at all — a permanently frozen
// zero with no clue why — and would need a rebuild just to toggle.
const storage = new AsyncLocalStorage();

// Parsed leniently on purpose: an env var pasted into Vercel can easily
// arrive as "true " or "True", and a strict === "true" would silently
// disable the whole feature on either of those.
export function monitorEnabled() {
  const raw = (process.env.QUERY_MONITOR_ENABLED || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}

function round(ms) {
  return Math.round(ms * 100) / 100;
}

// Called by lib/redis.js's instrumentation on every Redis command. No-op
// outside a withMonitorApi/withMonitorPage context (fire-and-forget paths
// like lib/audit.js's best-effort logging have no surrounding request), so
// this never throws and needs no guard at its call sites.
export function recordQuery(command, ms) {
  const store = storage.getStore();
  if (!store) return;
  store.queries.push({ command, ms: round(ms) });
}

// Same, for outbound HTTP to a third party (bunny.net, Resend, web-push).
// Redis commands aren't the only cost of a request — a screen that does zero
// Redis calls but two bunny.net round-trips would otherwise read as free.
export function recordExternal(label, ms) {
  const store = storage.getStore();
  if (!store) return;
  store.external.push({ label, ms: round(ms) });
}

function totals(store, wallMs) {
  const queryMs = store.queries.reduce((sum, q) => sum + q.ms, 0);
  const externalMs = store.external.reduce((sum, e) => sum + e.ms, 0);
  return {
    queryCount: store.queries.length,
    queryMs: round(queryMs),
    externalCount: store.external.length,
    externalMs: round(externalMs),
    wallMs: round(wallMs),
  };
}

// Full detail, for getServerSideProps props — serialized into the page,
// where there is no practical size ceiling.
function fullSnapshot(store, wallMs) {
  return { ...totals(store, wallMs), queries: store.queries, external: store.external };
}

// Counts only, for the response header. Headers have platform size limits
// and cost bytes on every API call, so per-command detail is deliberately
// left out here.
function headerSnapshot(store, wallMs) {
  return totals(store, wallMs);
}

function newStore() {
  return { queries: [], external: [] };
}

// Wrap an API route handler. When enabled, runs it inside the
// AsyncLocalStorage context so Redis/bunny/mail/push calls get attributed to
// this request, then attaches the stats as a response header just before the
// response is sent (res.json/res.end are patched for this call only).
export function withMonitorApi(handler) {
  return async (req, res) => {
    if (!monitorEnabled()) return handler(req, res);
    const store = newStore();
    const start = process.hrtime.bigint();
    const attach = () => {
      if (res.headersSent) return;
      try {
        const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
        res.setHeader("X-Query-Monitor", JSON.stringify(headerSnapshot(store, wallMs)));
      } catch {
        // never let monitoring break the response
      }
    };
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      attach();
      return originalJson(body);
    };
    const originalEnd = res.end.bind(res);
    res.end = (...args) => {
      attach();
      return originalEnd(...args);
    };
    return storage.run(store, () => handler(req, res));
  };
}

// Wrap a page's getServerSideProps. When enabled, attaches `_monitor` stats
// onto the resolved props; redirect/notFound results pass through untouched.
export function withMonitorPage(gssp) {
  return async (ctx) => {
    if (!monitorEnabled()) return gssp(ctx);
    const store = newStore();
    const start = process.hrtime.bigint();
    const result = await storage.run(store, () => gssp(ctx));
    if (result && result.props) {
      const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
      result.props._monitor = fullSnapshot(store, wallMs);
    }
    return result;
  };
}
