// pages/api/search.js — the filtering, which is now load-bearing.
//
// The route this replaces (/api/transcript-search) returned IDS ONLY, so even
// a wrong answer could only widen a list the client already held: an id it did
// not hold matched nothing. That backstop cannot survive here, because the
// whole point is to return videos the client does NOT hold — a video past the
// homepage cap. So the scope and schedule filtering is the only thing standing
// between a search and a video the viewer may not see, and it is tested here
// rather than assumed from the shape of the response.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

let access = null;
let allowed = true;
let libraryVideos = [];
let libraryThrows = false;
let transcripts = {};
let transcriptsThrow = false;
let translated = new Set();
let translatedThrows = false;
let translatedQuery = null;
let capSeen = null;
let scopeSeen;

vi.mock("../guard", () => ({
  requireAccess: async (req, res) => {
    if (!access) {
      res.status(401).json({ error: "Sign in" });
      return null;
    }
    return access;
  },
}));
vi.mock("../ratelimit", () => ({ allowRequest: async () => allowed }));
vi.mock("../videoList", () => ({
  fetchVideoLibrary: async (scope, options) => {
    if (libraryThrows) throw new Error("bunny down");
    scopeSeen = scope;
    capSeen = options?.cap;
    return { videos: libraryVideos, thumbnails: true };
  },
}));
vi.mock("../captionsStore", () => ({
  getTranscriptTextMap: async () => {
    if (transcriptsThrow) throw new Error("redis down");
    return transcripts;
  },
  matchingTranslatedIds: async (q) => {
    translatedQuery = q;
    if (translatedThrows) throw new Error("redis down");
    return translated;
  },
}));

const route = (await import("../../pages/api/search")).default;

const search = (q) => callRoute(route, { method: "GET", query: { q } });

beforeEach(() => {
  access = { email: "viewer@example.com", approved: true, staff: false, videoScope: null };
  allowed = true;
  libraryVideos = [
    { id: "vid-1", title: "Sunday service", notes: "Philippians 4", collectionId: "" },
    { id: "vid-2", title: "Harbour tour", notes: "", collectionId: "" },
  ];
  libraryThrows = false;
  transcripts = {};
  transcriptsThrow = false;
  translated = new Set();
  translatedThrows = false;
  translatedQuery = null;
  capSeen = null;
  scopeSeen = undefined;
});

describe("the gate", () => {
  it("refuses a caller with no access", async () => {
    access = null;
    expect((await search("sunday")).statusCode).toBe(401);
  });

  it("is rate limited", async () => {
    allowed = false;
    expect((await search("sunday")).statusCode).toBe(429);
  });

  it("rejects a non-GET", async () => {
    expect((await callRoute(route, { method: "POST", body: {} })).statusCode).toBe(405);
  });
});

describe("what it searches", () => {
  it("passes the viewer's OWN scope down to the library", async () => {
    // The filtering happens inside fetchVideoLibrary; handing it the wrong
    // scope — or none — is how this route would start returning videos the
    // viewer may not see.
    access = { ...access, videoScope: ["vid-2"] };
    await search("harbour");
    expect(scopeSeen).toEqual(["vid-2"]);
  });

  it("asks for the library WITHOUT the display cap", async () => {
    // This is the entire feature: the cap is why a video past the first page
    // could not be found. If this ever goes back to the capped call, search
    // silently stops reaching the rest of the library.
    await search("sunday");
    expect(capSeen).toBe(false);
  });

  it("matches titles, notes and what was said", async () => {
    transcripts = { "vid-2": "we dropped the anchor at noon" };
    expect((await search("philippians")).body.videos.map((v) => v.id)).toEqual(["vid-1"]);
    expect((await search("anchor")).body.videos.map((v) => v.id)).toEqual(["vid-2"]);
  });

  it("returns full video objects, not bare ids", async () => {
    // Deliberate, and the reason the filtering above is load-bearing: the
    // client cannot render a video it does not already hold.
    const res = await search("harbour");
    expect(res.body.videos[0]).toMatchObject({ id: "vid-2", title: "Harbour tour" });
  });
});

describe("degrading", () => {
  it("still answers on title and notes when transcripts are unreadable", async () => {
    // Losing spoken matches costs this query its extra results. A 502 would
    // make the search box look broken for a search that can still be served.
    transcriptsThrow = true;
    const res = await search("philippians");
    expect(res.statusCode).toBe(200);
    expect(res.body.videos.map((v) => v.id)).toEqual(["vid-1"]);
  });

  it("502s when the library itself cannot be read", async () => {
    // Here there is no partial answer to give, and pretending the library is
    // empty would read as "no matches" — a wrong answer, not a missing one.
    libraryThrows = true;
    expect((await search("sunday")).statusCode).toBe(502);
  });

  it("answers an empty query with nothing, and does not call the library", async () => {
    const res = await search("   ");
    expect(res.body).toEqual({ videos: [], total: 0, truncated: false });
    expect(capSeen).toBeNull();
  });
});

describe("searching translations", () => {
  it("finds a video by words said in one of its translations", async () => {
    translated = new Set(["vid-2"]);
    const res = await search("dónde está");
    expect(translatedQuery).toBe("dónde está");
    expect(res.body.videos.map((v) => v.id)).toEqual(["vid-2"]);
  });

  it("never returns a translated match outside the viewer's library", async () => {
    // The store searches every video's translations; only the route's
    // already-filtered library decides what may come back.
    translated = new Set(["vid-hidden", "vid-2"]);
    const res = await search("dónde está");
    expect(res.body.videos.map((v) => v.id)).toEqual(["vid-2"]);
  });

  it("still answers from titles, notes and the default track when translations cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    translatedThrows = true;
    const res = await search("sunday");
    expect(res.statusCode).toBe(200);
    expect(res.body.videos.map((v) => v.id)).toEqual(["vid-1"]);
  });
});
