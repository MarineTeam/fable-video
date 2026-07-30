// Client half of the Query Monitor. Deliberately separate from lib/monitor.js
// (server-only, pulls in async_hooks) — this module must be safe in the
// browser bundle. It owns the store of observed API calls, a pub/sub, and
// resetMonitorCalls(), so a page can signal "the view changed" without
// importing a React component just to reach a side-effecting helper.
//
// There is NO build-time client flag. Whether the monitor is on is decided
// server-side by QUERY_MONITOR_ENABLED and learned at runtime via
// /api/monitor, so one env var toggles the whole feature with no rebuild.
// The fetch wrapper below installs unconditionally as a trade-off: it's a
// pure pass-through that reads one response header and never throws, and it
// stops recording entirely the moment the server reports the monitor is off.

const MAX_CALLS = 100;

let calls = [];
// Cumulative since the last full page load — deliberately NOT cleared by
// resetMonitorCalls. A screen's first visit includes its one-time bootstrap
// fetches; a later revisit doesn't, so a per-view number can legitimately
// drop. Keeping both totals is what makes that drop read as arithmetic
// instead of a bug.
let sinceLoad = { calls: 0, queryCount: 0, queryMs: 0, externalCount: 0, externalMs: 0 };
let recording = true; // until /api/monitor says otherwise
const listeners = new Set();

function emit() {
  listeners.forEach((fn) => fn(calls, sinceLoad));
}

export function getMonitorCalls() {
  return calls;
}

export function getSinceLoad() {
  return sinceLoad;
}

// Subscribe to the call log. Fires immediately with the current value and
// returns an unsubscribe function.
export function subscribeMonitorCalls(fn) {
  listeners.add(fn);
  fn(calls, sinceLoad);
  return () => listeners.delete(fn);
}

// Start a fresh view. Call this whenever the user moves to a logically new
// screen that isn't a route change — e.g. the admin panel's tabs, which are
// pure React state. Without it the panel either grows forever (tabs that
// lazily fetch) or looks frozen (tabs whose data loaded once upfront)
// instead of showing what the current view actually cost.
export function resetMonitorCalls() {
  if (calls.length === 0) return;
  calls = [];
  emit();
}

// Called once /api/monitor has answered. When the monitor is off, drop
// whatever was buffered and stop recording, so a disabled deployment keeps
// no state around.
export function setMonitorRecording(on) {
  recording = Boolean(on);
  if (!recording && calls.length) {
    calls = [];
    sinceLoad = { calls: 0, queryCount: 0, queryMs: 0, externalCount: 0, externalMs: 0 };
    emit();
  }
}

// Installed at module-evaluation time — on import, before _app renders and
// before any page's own effects fire. Doing this in a useEffect would race
// other components' data-fetching effects (React runs child effects before
// parent ones), so whichever fired first would use the unpatched fetch and
// be invisible to the monitor.
if (
  typeof window !== "undefined" &&
  typeof window.fetch === "function" &&
  !window.fetch.__queryMonitorPatched
) {
  const originalFetch = window.fetch.bind(window);
  const patched = async (...args) => {
    const res = await originalFetch(...args);
    if (!recording) return res;
    try {
      const raw = res.headers.get("X-Query-Monitor");
      if (raw) {
        const stats = JSON.parse(raw);
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        // The panel's own heartbeat would otherwise make every total climb
        // on its own, on an idle page.
        if (!url.startsWith("/api/monitor")) {
          calls = [...calls, { url, ...stats }].slice(-MAX_CALLS);
          sinceLoad = {
            calls: sinceLoad.calls + 1,
            queryCount: sinceLoad.queryCount + (stats.queryCount || 0),
            queryMs: Math.round((sinceLoad.queryMs + (stats.queryMs || 0)) * 100) / 100,
            externalCount: sinceLoad.externalCount + (stats.externalCount || 0),
            externalMs: Math.round((sinceLoad.externalMs + (stats.externalMs || 0)) * 100) / 100,
          };
          emit();
        }
      }
    } catch {
      // A monitoring wrapper must never affect the request it observes.
    }
    return res;
  };
  patched.__queryMonitorPatched = true;
  window.fetch = patched;
}
