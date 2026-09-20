// pages/api/admin/transcribe.js — the money and the writes.
//
// Two things about this route must not drift. It SPENDS MONEY, so the paid
// branch stays behind the capability gate and the rate limit, and the two free
// branches (ingest, suggestions) must not be able to trigger a charge. And
// chapter suggestions must stay SUGGESTIONS: reading them back writes nothing,
// so a transcription job can never replace a chapter list an admin typed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

let admin = "admin@example.com";
let allowed = true;
let video = {};

const transcribeVideo = vi.fn(async () => ({ ok: true }));
const getVideo = vi.fn(async () => video);
const fetchCaptionVtt = vi.fn(async () => "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello\n");
const setTranscript = vi.fn(async () => ({ ok: true }));
const logAction = vi.fn(async () => {});

vi.mock("../guard", () => ({
  requireCapability: async (req, res) => {
    if (!admin) {
      res.status(403).json({ error: "Not allowed" });
      return null;
    }
    return admin;
  },
}));
vi.mock("../ratelimit", () => ({ allowRequest: async () => allowed }));
vi.mock("../bunny", () => ({
  transcribeVideo: (...args) => transcribeVideo(...args),
  getVideo: (...args) => getVideo(...args),
  fetchCaptionVtt: (...args) => fetchCaptionVtt(...args),
}));
vi.mock("../captionsStore", () => ({ setTranscript: (...args) => setTranscript(...args) }));
vi.mock("../audit", () => ({ logAction: (...args) => logAction(...args) }));

const route = (await import("../../pages/api/admin/transcribe")).default;

const call = (body) => callRoute(route, { method: "POST", body });

beforeEach(() => {
  admin = "admin@example.com";
  allowed = true;
  video = { guid: "vid-1", captions: [], chapters: [] };
  transcribeVideo.mockClear();
  getVideo.mockClear();
  setTranscript.mockClear();
  logAction.mockClear();
});

describe("the paid branch", () => {
  it("needs the capability", async () => {
    admin = null;
    const res = await call({ guid: "vid-1" });
    expect(res.statusCode).toBe(403);
    expect(transcribeVideo).not.toHaveBeenCalled();
  });

  it("is rate limited", async () => {
    allowed = false;
    const res = await call({ guid: "vid-1" });
    expect(res.statusCode).toBe(429);
    expect(transcribeVideo).not.toHaveBeenCalled();
  });

  it("leaves chapter generation off unless it was asked for in so many words", async () => {
    await call({ guid: "vid-1" });
    expect(transcribeVideo.mock.calls[0][1].generateChapters).toBe(false);

    // Truthy is not enough — the same rule `force` follows.
    await call({ guid: "vid-1", chapters: "yes" });
    expect(transcribeVideo.mock.calls[1][1].generateChapters).toBe(false);
  });

  it("asks for chapters when the admin ticked the box", async () => {
    const res = await call({ guid: "vid-1", chapters: true });
    expect(transcribeVideo.mock.calls[0][1].generateChapters).toBe(true);
    expect(res.body.chapters).toBe(true);
    expect(logAction.mock.calls[0][2]).toContain("chapter suggestions");
  });
});

describe("reading suggestions back", () => {
  beforeEach(() => {
    video = {
      guid: "vid-1",
      chapters: [
        { title: "Worship", start: 0 },
        { title: "Sermon", start: 1455 },
      ],
    };
  });

  it("returns the parsed proposal", async () => {
    const res = await call({ guid: "vid-1", suggestions: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.chapters).toEqual([
      { t: 0, label: "Worship" },
      { t: 1455, label: "Sermon" },
    ]);
  });

  it("WRITES NOTHING — not the chapters, not the transcript, not the audit log", async () => {
    await call({ guid: "vid-1", suggestions: true });
    expect(setTranscript).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it("never spends money, even when the rate limit is exhausted", async () => {
    allowed = false;
    const res = await call({ guid: "vid-1", suggestions: true });
    expect(res.statusCode).toBe(200);
    expect(transcribeVideo).not.toHaveBeenCalled();
  });

  it("still needs the capability", async () => {
    admin = null;
    const res = await call({ guid: "vid-1", suggestions: true });
    expect(res.statusCode).toBe(403);
    expect(getVideo).not.toHaveBeenCalled();
  });

  it("reports a missing video as 404", async () => {
    getVideo.mockImplementationOnce(async () => {
      const err = new Error("nope");
      err.status = 404;
      throw err;
    });
    const res = await call({ guid: "vid-1", suggestions: true });
    expect(res.statusCode).toBe(404);
  });

  it("answers with an empty proposal when bunny generated nothing", async () => {
    video = { guid: "vid-1" };
    const res = await call({ guid: "vid-1", suggestions: true });
    expect(res.body).toEqual({ ok: true, chapters: [], ignored: [] });
  });
});

describe("ingest", () => {
  it("does not queue a paid job", async () => {
    video = { guid: "vid-1", captions: [{ srclang: "en" }] };
    const res = await call({ guid: "vid-1", ingest: true });
    expect(res.statusCode).toBe(200);
    expect(transcribeVideo).not.toHaveBeenCalled();
    expect(setTranscript).toHaveBeenCalled();
  });
});

describe("shape", () => {
  it("rejects a missing guid before anything else", async () => {
    const res = await call({});
    expect(res.statusCode).toBe(400);
    expect(transcribeVideo).not.toHaveBeenCalled();
  });

  it("rejects a non-POST", async () => {
    const res = await callRoute(route, { method: "GET", body: {} });
    expect(res.statusCode).toBe(405);
  });
});
