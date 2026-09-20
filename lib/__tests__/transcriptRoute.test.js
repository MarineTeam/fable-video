// pages/api/transcript/[id].js — the gate, not the parsing.
//
// A transcript is the entire content of a private video in text form, so this
// route must be exactly as strict as pages/watch/video/[id].js. These tests
// exist to catch it drifting laxer: each one corresponds to a check that page
// performs, and would fail if the route stopped performing it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

// The access object requireAccess resolves to. Mutated per test.
let access = null;
let schedule = null;
let scheduleThrows = false;
const getTranscript = vi.fn(async () => [{ start: 1, end: 2, text: "spoken words" }]);
let languages = { default: "en", all: ["en"] };

vi.mock("../guard", () => ({
  requireAccess: async (req, res) => {
    if (!access) {
      res.status(401).json({ error: "Sign in" });
      return null;
    }
    return access;
  },
}));
vi.mock("../schedule", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getSchedule: async () => {
      if (scheduleThrows) throw new Error("redis down");
      return schedule;
    },
  };
});
vi.mock("../captionsStore", () => ({
  getTranscript: (...args) => getTranscript(...args),
  getTranscriptLanguages: async () => languages,
}));

const route = (await import("../../pages/api/transcript/[id]")).default;

const approved = { email: "viewer@example.com", approved: true, staff: false, videoScope: null };

function call(id = "vid-1") {
  return callRoute(route, { method: "GET", query: { id } });
}

beforeEach(() => {
  access = { ...approved };
  schedule = null;
  scheduleThrows = false;
  getTranscript.mockClear();
  languages = { default: "en", all: ["en"] };
});

describe("who can read a transcript", () => {
  it("serves cues to an approved viewer", async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.cues).toHaveLength(1);
  });

  it("refuses an anonymous caller before touching storage", async () => {
    access = null;
    const res = await call();
    expect(res.statusCode).toBe(401);
    expect(getTranscript).not.toHaveBeenCalled();
  });

  // The id is in the URL, so a restricted viewer who learns one another way
  // must still be turned away — exactly the watch page's reasoning.
  it("404s a video outside the viewer's group scope, and reads nothing", async () => {
    access = { ...approved, videoScope: ["other-video"] };
    const res = await call("vid-1");
    expect(res.statusCode).toBe(404);
    expect(getTranscript).not.toHaveBeenCalled();
  });

  it("serves a video that IS inside the viewer's scope", async () => {
    access = { ...approved, videoScope: ["vid-1"] };
    expect((await call("vid-1")).statusCode).toBe(200);
  });

  // 404 not 403: a restricted viewer must not be able to probe which ids exist.
  it("uses 404 rather than 403 so ids cannot be probed", async () => {
    access = { ...approved, videoScope: [] };
    const res = await call("vid-1");
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("permission");
  });
});

describe("publish window", () => {
  it("404s a video outside its publish window", async () => {
    schedule = { publishAt: Date.now() + 60_000 };
    const res = await call();
    expect(res.statusCode).toBe(404);
    expect(getTranscript).not.toHaveBeenCalled();
  });

  // Staff preview an unpublished video on the watch page; the transcript must
  // not contradict that.
  it("lets staff read a transcript outside the window", async () => {
    access = { ...approved, staff: true };
    schedule = { publishAt: Date.now() + 60_000 };
    expect((await call()).statusCode).toBe(200);
  });

  // Matches lib/videoList.js and the watch page: an unreadable schedule means
  // no constraint, rather than taking live content off the air.
  it("treats an unreadable schedule as no constraint", async () => {
    scheduleThrows = true;
    expect((await call()).statusCode).toBe(200);
  });
});

describe("shape", () => {
  it("400s without an id", async () => {
    const res = await callRoute(route, { method: "GET", query: {} });
    expect(res.statusCode).toBe(400);
  });

  // oneTrimmed, so a repeated query key cannot be coerced into "a,b".
  it("400s on a wrong-typed id rather than stringifying it", async () => {
    const res = await callRoute(route, { method: "GET", query: { id: ["a", "b"] } });
    expect(res.statusCode).toBe(400);
  });

  it("405s a non-GET and names the allowed verb", async () => {
    const res = await callRoute(route, { method: "POST", query: { id: "vid-1" } });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET");
  });

  // Most videos have never been transcribed. That is a normal 200 with an
  // empty list, not an error the watch page has to handle.
  it("returns an empty cue list rather than an error when untranscribed", async () => {
    getTranscript.mockResolvedValueOnce([]);
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.cues).toEqual([]);
  });

  it("502s when storage fails, without leaking the error", async () => {
    getTranscript.mockRejectedValueOnce(new Error("redis exploded"));
    const res = await call();
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("exploded");
  });
});

// --- Language selection ----------------------------------------------------
//
// The gate above decides WHETHER a transcript is served; these decide WHICH.
// The rule that matters: a language we do not have is never quietly answered
// with a different one without saying so.
describe("which language it serves", () => {
  it("serves the video's default when none is asked for", async () => {
    languages = { default: "de", all: ["de", "en"] };
    const res = await call();
    expect(res.body.language).toBe("de");
    expect(res.body.languages).toEqual(["de", "en"]);
    expect(res.body.missing).toBe(false);
  });

  it("serves the language that was asked for", async () => {
    languages = { default: "en", all: ["de", "en"] };
    const res = await callRoute(route, { method: "GET", query: { id: "vid-1", lang: "de" } });
    expect(res.body.language).toBe("de");
    expect(getTranscript).toHaveBeenCalledWith("vid-1", "de");
  });

  it("REPORTS a language it does not have rather than pretending", async () => {
    // Showing English under a Spanish selection makes the translation look
    // wrong rather than absent.
    languages = { default: "en", all: ["en"] };
    const res = await callRoute(route, { method: "GET", query: { id: "vid-1", lang: "es" } });
    expect(res.body.missing).toBe(true);
    expect(res.body.language).toBe("en");
  });

  it("answers a video with no transcript the same way it always did", async () => {
    languages = { default: null, all: [] };
    getTranscript.mockImplementationOnce(async () => []);
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.cues).toEqual([]);
    expect(res.body.languages).toEqual([]);
  });
});
