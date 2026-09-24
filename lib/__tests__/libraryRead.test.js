// lib/bunny.js listAllVideosWithStatus — a whole-library read, bounded at
// 1,000 videos and honest about the bound.
//
// It stopped at 5 pages (500 videos) and said nothing: past that, the oldest
// videos were missing from the homepage, search, the admin Videos tab and
// Analytics with no sign anything was cut. Real bunny.js here, over a stubbed
// fetch that pages the way bunny does.
import { beforeEach, describe, expect, it, vi } from "vitest";

let library = [];
let servedPerPage = null;
let pagesAsked = [];
let uploadAfterFirstPage = null;
let clock = 1_000_000;

vi.stubGlobal("fetch", async (url) => {
  const params = new URL(url).searchParams;
  const page = Number(params.get("page"));
  const asked = Number(params.get("itemsPerPage"));
  pagesAsked.push(page);
  if (page === 2 && uploadAfterFirstPage) {
    library = [uploadAfterFirstPage, ...library];
    uploadAfterFirstPage = null;
  }
  const size = servedPerPage || asked;
  const items = library.slice((page - 1) * size, page * size);
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ items, totalItems: library.length }),
  };
});
vi.spyOn(Date, "now").mockImplementation(() => clock);

const { listAllVideos, listAllVideosWithStatus, MAX_LIBRARY_PAGES } = await import("../bunny");

const makeLibrary = (n) => Array.from({ length: n }, (_, i) => ({ guid: `v${i + 1}` }));

beforeEach(() => {
  library = [];
  servedPerPage = null;
  pagesAsked = [];
  uploadAfterFirstPage = null;
  // Past the short in-process cache, so every test reads afresh.
  clock += 60_000;
});

describe("listAllVideosWithStatus", () => {
  it("reads up to 10 pages — 1,000 videos", () => {
    expect(MAX_LIBRARY_PAGES).toBe(10);
  });

  it("reads a library of 800 whole — past the old 500 bound", async () => {
    library = makeLibrary(800);
    const out = await listAllVideosWithStatus();
    expect(out.videos).toHaveLength(800);
    expect(out.videos.at(-1).guid).toBe("v800");
    expect(out.truncated).toBe(false);
    expect(out.total).toBe(800);
  });

  it("stops at 1,000 and says so, with the real total", async () => {
    library = makeLibrary(1234);
    const out = await listAllVideosWithStatus();
    expect(out.videos).toHaveLength(1000);
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(1234);
    expect(Math.max(...pagesAsked)).toBe(10);
  });

  it("a library of exactly 1,000 is complete, not truncated", async () => {
    library = makeLibrary(1000);
    const out = await listAllVideosWithStatus();
    expect(out.videos).toHaveLength(1000);
    expect(out.truncated).toBe(false);
  });

  it("a one-page library is one request", async () => {
    library = makeLibrary(40);
    const out = await listAllVideosWithStatus();
    expect(out).toEqual({ videos: library, truncated: false, total: 40 });
    expect(pagesAsked).toEqual([1]);
  });

  it("counts pages in the size bunny served, when it serves fewer than asked", async () => {
    library = makeLibrary(230);
    servedPerPage = 50;
    const out = await listAllVideosWithStatus();
    expect(out.videos).toHaveLength(230);
    expect(out.truncated).toBe(false);
  });

  it("never lists a video twice when an upload shifts one across a page boundary", async () => {
    library = makeLibrary(150);
    uploadAfterFirstPage = { guid: "new" };
    const guids = (await listAllVideosWithStatus()).videos.map((v) => v.guid);
    expect(new Set(guids).size).toBe(guids.length);
  });

  it("listAllVideos is the same read, videos only", async () => {
    library = makeLibrary(120);
    expect(await listAllVideos()).toHaveLength(120);
  });
});
