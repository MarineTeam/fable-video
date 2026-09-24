// Collecting a finished transcription without the admin's second click.
//
// This runs on a request an admin made for something else, so the rule that
// matters most is that it can never make that request fail — and the rule
// just behind it is that a marker is only cleared when the work is genuinely
// done, or genuinely hopeless. Clearing early loses a transcript that was
// already paid for, with nothing left to say it is missing.
import { beforeEach, describe, expect, it, vi } from "vitest";

let pending = {};
let videos = {};
let vttByKey = {};
let stored = {};
let alt = {};
let index = {};
let getVideoThrows = false;
let fetchThrows = false;
let lockFree = true;
const lockEvents = [];
const checked = [];

vi.mock("../bunny", () => ({
  getVideo: async (guid) => {
    checked.push(guid);
    if (getVideoThrows) throw new Error("bunny down");
    return videos[guid] || {};
  },
  fetchCaptionVtt: async (guid, lang) => {
    if (fetchThrows) throw new Error("cdn down");
    return vttByKey[`${guid}:${lang}`] || "";
  },
}));
vi.mock("../captionsStore", () => ({
  acquireCollectLock: async () => {
    lockEvents.push("acquire");
    return lockFree ? "token-1" : null;
  },
  releaseCollectLock: async (token) => {
    lockEvents.push(`release:${token}`);
  },
  getTranscribePending: async () => pending,
  clearTranscribePending: async (guids) => {
    for (const guid of Array.isArray(guids) ? guids : [guids]) delete pending[guid];
  },
  setTranscript: async (guid, cues) => {
    stored[guid] = cues;
  },
  setTranscriptLanguage: async (guid, lang, cues) => {
    alt[`${guid}:${lang}`] = cues;
  },
  setTranscriptLanguages: async (guid, defaultLang, langs) => {
    index[guid] = { default: defaultLang, all: langs };
  },
}));

const { collectFinishedTranscripts } = await import("../transcriptCollect");

const OLD = Date.now() - 10 * 60 * 1000;
const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello there\n";

beforeEach(() => {
  pending = {};
  videos = {};
  vttByKey = {};
  stored = {};
  alt = {};
  index = {};
  getVideoThrows = false;
  fetchThrows = false;
  lockFree = true;
  lockEvents.length = 0;
  checked.length = 0;
});

describe("collecting", () => {
  beforeEach(() => {
    pending = { "vid-1": OLD };
    videos["vid-1"] = { guid: "vid-1", captions: [{ srclang: "en" }] };
    vttByKey["vid-1:en"] = vtt;
  });

  it("stores the transcript and clears the marker", async () => {
    const result = await collectFinishedTranscripts();
    expect(stored["vid-1"]).toHaveLength(1);
    expect(pending["vid-1"]).toBeUndefined();
    expect(result.collected).toEqual([
      { guid: "vid-1", language: "en", cues: 1, languages: ["en"] },
    ]);
  });

  it("prefers English as the DEFAULT when bunny produced several", async () => {
    // Collecting a different default than the button would have is a surprise
    // nobody needs.
    videos["vid-1"].captions = [{ srclang: "de" }, { srclang: "en" }];
    vttByKey["vid-1:de"] = vtt;
    const result = await collectFinishedTranscripts();
    expect(result.collected[0].language).toBe("en");
  });

  it("stores EVERY track, not just the default", async () => {
    // Translation is billed per language. A portal that paid for German and
    // got only English back has paid for nothing.
    videos["vid-1"].captions = [{ srclang: "en" }, { srclang: "de" }];
    vttByKey["vid-1:de"] = vtt;
    const result = await collectFinishedTranscripts();
    // Copy before sorting: .sort() mutates, and this is the same array the
    // store was handed — sorting it here would rewrite what the next
    // assertion is checking.
    expect([...result.collected[0].languages].sort()).toEqual(["de", "en"]);
    expect(alt["vid-1:de"]).toHaveLength(1);
    expect(index["vid-1"]).toEqual({ default: "en", all: ["en", "de"] });
  });

  it("keeps the default when one translation is unreadable", async () => {
    // One bad track must not cost the others, or the default.
    videos["vid-1"].captions = [{ srclang: "en" }, { srclang: "de" }];
    vttByKey["vid-1:de"] = "WEBVTT\n\n";
    const result = await collectFinishedTranscripts();
    expect(result.collected[0].languages).toEqual(["en"]);
    expect(stored["vid-1"]).toHaveLength(1);
  });

  it("stores NOTHING when the default track does not parse", async () => {
    // A picker over an empty transcript is worse than no picker: the video
    // would look transcribed and read as blank.
    videos["vid-1"].captions = [{ srclang: "en" }, { srclang: "de" }];
    vttByKey["vid-1:en"] = "WEBVTT\n\n";
    vttByKey["vid-1:de"] = vtt;
    await collectFinishedTranscripts();
    expect(stored["vid-1"]).toBeUndefined();
    expect(alt["vid-1:de"]).toBeUndefined();
    expect(pending["vid-1"]).toBe(OLD);
  });
});

describe("leaving a marker alone", () => {
  it("keeps waiting when bunny has produced no captions yet", async () => {
    // The usual case for the first few minutes. Clearing here would abandon a
    // transcription that was already paid for.
    pending = { "vid-1": OLD };
    videos["vid-1"] = { guid: "vid-1", captions: [] };
    const result = await collectFinishedTranscripts();
    expect(pending["vid-1"]).toBe(OLD);
    expect(result.collected).toEqual([]);
  });

  it("keeps waiting when the caption file parses to nothing", async () => {
    pending = { "vid-1": OLD };
    videos["vid-1"] = { guid: "vid-1", captions: [{ srclang: "en" }] };
    vttByKey["vid-1:en"] = "WEBVTT\n\n";
    await collectFinishedTranscripts();
    expect(pending["vid-1"]).toBe(OLD);
  });

  it("keeps waiting when bunny fails, so a blip is retried", async () => {
    pending = { "vid-1": OLD };
    getVideoThrows = true;
    const result = await collectFinishedTranscripts();
    expect(pending["vid-1"]).toBe(OLD);
    expect(result.collected).toEqual([]);
  });

  it("keeps waiting when the caption fetch fails", async () => {
    pending = { "vid-1": OLD };
    videos["vid-1"] = { guid: "vid-1", captions: [{ srclang: "en" }] };
    fetchThrows = true;
    await collectFinishedTranscripts();
    expect(pending["vid-1"]).toBe(OLD);
  });
});

describe("never breaking the request it rides on", () => {
  it("does not throw when bunny is down", async () => {
    pending = { "vid-1": OLD };
    getVideoThrows = true;
    await expect(collectFinishedTranscripts()).resolves.toBeTruthy();
  });

  it("does nothing at all when nothing is pending", async () => {
    const result = await collectFinishedTranscripts();
    expect(result).toEqual({ collected: [], expired: [], busy: false });
  });

  it("carries on to the next video after one fails", async () => {
    // One bad guid must not strand every other queued transcription.
    pending = { bad: OLD, good: OLD - 1000 };
    videos.good = { guid: "good", captions: [{ srclang: "en" }] };
    vttByKey["good:en"] = vtt;
    // `bad` has no entry in `videos`, so it yields {} and simply stays pending.
    const result = await collectFinishedTranscripts();
    expect(result.collected.map((c) => c.guid)).toEqual(["good"]);
    expect(pending.bad).toBe(OLD);
  });
});

describe("giving up", () => {
  it("drops a marker that is past the deadline, without fetching it", async () => {
    pending = { ancient: Date.now() - 4 * 24 * 60 * 60 * 1000 };
    const result = await collectFinishedTranscripts();
    expect(result.expired).toEqual(["ancient"]);
    expect(pending.ancient).toBeUndefined();
    expect(stored.ancient).toBeUndefined();
  });

  it("still tries a job two days old — a once-a-day schedule must get a second attempt", async () => {
    pending = { slow: Date.now() - 48 * 60 * 60 * 1000 };
    videos.slow = { captions: [{ srclang: "en" }] };
    vttByKey["slow:en"] = vtt;
    const result = await collectFinishedTranscripts();
    expect(result.expired).toEqual([]);
    expect(stored.slow).toHaveLength(1);
  });
});

describe("one run at a time", () => {
  it("does nothing, and says so, when another run holds the lock", async () => {
    lockFree = false;
    pending = { a: OLD };
    videos.a = { captions: [{ srclang: "en" }] };
    vttByKey["a:en"] = vtt;
    const result = await collectFinishedTranscripts();
    expect(result).toEqual({ collected: [], expired: [], busy: true });
    expect(checked).toEqual([]);
    expect(pending.a).toBe(OLD); // still pending for the run that holds the lock
    expect(lockEvents).toEqual(["acquire"]);
  });

  it("releases the lock it took, even when a video fails", async () => {
    pending = { a: OLD };
    getVideoThrows = true;
    await collectFinishedTranscripts();
    expect(lockEvents).toEqual(["acquire", "release:token-1"]);
  });

  it("does not touch the lock when nothing is pending", async () => {
    await collectFinishedTranscripts();
    expect(lockEvents).toEqual([]);
  });
});

describe("how many per run", () => {
  const queue = (n) => {
    for (let i = 0; i < n; i += 1) pending[`v${i}`] = OLD - i;
  };

  it("checks the small default on an admin page load", async () => {
    queue(10);
    await collectFinishedTranscripts();
    expect(checked).toHaveLength(3);
  });

  it("checks up to the caller's limit on a scheduled run", async () => {
    queue(10);
    await collectFinishedTranscripts({ limit: 8 });
    expect(checked).toHaveLength(8);
  });
});
