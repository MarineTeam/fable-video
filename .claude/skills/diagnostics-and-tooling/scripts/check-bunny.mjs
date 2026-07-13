#!/usr/bin/env node
// check-bunny.mjs — verify bunny.net Stream API connectivity and report the
// video library's health by status code, using the same request the app's
// own lib/bunny.js listVideos() makes.
//
// USAGE
//   node .claude/skills/diagnostics-and-tooling/scripts/check-bunny.mjs
//
// WHAT IT DOES
//   1. Loads .env.local (if present) and resolves BUNNY_LIBRARY_ID +
//      BUNNY_API_KEY (trimmed, same as lib/bunny.js's env() helper — a
//      stray pasted newline corrupts the AccessKey header).
//   2. Imports listVideos from the repo's own lib/bunny.js and calls
//      listVideos({ page: 1, itemsPerPage: 100 }) — GET
//      /library/{id}/videos?page=1&itemsPerPage=100&orderBy=date against
//      https://video.bunnycdn.com, exactly as pages/api/videos.js does via
//      fetchVideoLibrary -> listAllVideos.
//   3. Reports totalItems (library-wide count) and, for the up-to-100
//      videos returned on this page, a per-status breakdown using bunny.net's
//      Stream status codes (see lib/bunny.js videoState() comment):
//        0 created, 1 uploaded, 2 processing, 3 transcoding, 4 finished,
//        5 error, 6 upload failed, 7+ = JIT states (already playable).
//   4. Distinguishes three failure modes clearly: not-configured (env vars
//      missing, no request made), auth-failed (401/403 — bad API key or
//      wrong library id), network-failed (DNS/TLS/timeout — no HTTP
//      response at all).
//
// SAFETY
//   Read-only: a single GET request. Never calls createVideo/updateVideo/
//   deleteVideo or any other mutating export from lib/bunny.js. Never
//   prints the API key value — only its length.
//
// EXPECTED OUTPUT (unconfigured — no BUNNY_LIBRARY_ID/BUNNY_API_KEY):
// reports which var is missing and exits 1 without making a request. See
// SKILL.md for the actual captured run.
//
// EXPECTED OUTPUT (with credentials, success):
//   totalItems: 42
//   -- Status breakdown (first 42 of 42 items) --
//     0 created           1
//     4 finished         38
//     5 error             2
//     6 upload failed     1
//   RESULT: connected, library reachable.
// exits 0 on a successful API call (regardless of how many videos are in
// error/failed states — that's a report, not a script failure), 1 on
// not-configured / auth-failed / network-failed.
//
// EXPECTED OUTPUT (with credentials, bad API key):
//   STATUS: auth failed (HTTP 401) — check BUNNY_API_KEY and BUNNY_LIBRARY_ID.
// exits 1.

import { loadDotEnvLocal, mask, repoRoot, printHeader } from "./_lib.mjs";

loadDotEnvLocal();

printHeader("check-bunny — bunny.net Stream library health");
console.log(`repo root: ${repoRoot()}`);
console.log("");

const libraryId = (process.env.BUNNY_LIBRARY_ID || "").trim();
const apiKey = (process.env.BUNNY_API_KEY || "").trim();

if (!libraryId || !apiKey) {
  console.log("STATUS: not configured — no request made.");
  console.log(`  BUNNY_LIBRARY_ID: ${libraryId ? `set (${mask(libraryId)})` : "MISSING"}`);
  console.log(`  BUNNY_API_KEY:    ${apiKey ? `set (${mask(apiKey)})` : "MISSING"}`);
  console.log("");
  console.log("Set these in .env.local (see .claude/skills/environment-and-config) and re-run.");
  process.exit(1);
}

let bunnyModule;
try {
  // Imported from the repo's own lib/bunny.js for fidelity — same
  // listVideos() call pages/api/videos.js reaches via fetchVideoLibrary ->
  // listAllVideos. Node 22 reparses this CommonJS-looking .js file as ESM
  // automatically; the resulting MODULE_TYPELESS_PACKAGE_JSON warning on
  // stderr is expected and harmless (see SKILL.md).
  bunnyModule = await import(new URL("../../../../lib/bunny.js", import.meta.url));
} catch (err) {
  console.log(`STATUS: failed to load lib/bunny.js — ${err.message}`);
  process.exit(1);
}

const { listVideos } = bunnyModule;

const STATUS_LABELS = {
  0: "created",
  1: "uploaded",
  2: "processing",
  3: "transcoding",
  4: "finished",
  5: "error",
  6: "upload failed",
};

let data;
try {
  data = await listVideos({ page: 1, itemsPerPage: 100 });
} catch (err) {
  if (err.status === 401 || err.status === 403) {
    console.log(`STATUS: auth failed (HTTP ${err.status}) — check BUNNY_API_KEY and BUNNY_LIBRARY_ID.`);
    process.exit(1);
  }
  if (typeof err.status === "number") {
    console.log(`STATUS: API error (HTTP ${err.status}) — ${err.message}`);
    process.exit(1);
  }
  console.log(`STATUS: network failed — ${err.message}`);
  console.log("No HTTP response received at all (DNS, TLS, timeout, or connectivity issue).");
  process.exit(1);
}

const items = data?.items || [];
const totalItems = data?.totalItems ?? items.length;

console.log(`totalItems (library-wide): ${totalItems}`);
console.log("");
console.log(`-- Status breakdown (first ${items.length} of ${totalItems} items) --`);

const counts = new Map();
for (const video of items) {
  const status = Number(video?.status);
  counts.set(status, (counts.get(status) || 0) + 1);
}

for (const status of [0, 1, 2, 3, 4, 5, 6]) {
  if (counts.has(status)) {
    console.log(`  ${String(status).padEnd(3)} ${STATUS_LABELS[status].padEnd(14)} ${counts.get(status)}`);
  }
}
let jitCount = 0;
for (const [status, count] of counts) {
  if (status > 6) jitCount += count;
}
if (jitCount > 0) console.log(`  >6  playable (JIT)   ${jitCount}`);

if (items.length < totalItems) {
  console.log("");
  console.log(
    `Note: only the first ${items.length} of ${totalItems} videos were fetched (itemsPerPage=100). ` +
      "The counts above cover that first page only, not the whole library."
  );
}

console.log("");
console.log("RESULT: connected, library reachable.");
process.exit(0);
