// The feed builder is pure, so these are about output correctness: valid,
// parseable XML that podcast apps accept, with every interpolated value
// escaped. An unescaped ampersand in one video title breaks the whole feed
// in every client at once, which is the failure mode worth a test.
import { describe, expect, it } from "vitest";
import {
  buildPodcastFeed,
  episodeSummary,
  escapeXml,
  itunesDuration,
  rfc822,
} from "../podcast";

const base = {
  siteName: "Grace Chapel",
  selfUrl: "https://portal.example.com/api/feed/tok",
  siteUrl: "https://portal.example.com",
  imageUrl: "https://portal.example.com/icon-512.png",
  now: "2026-09-13T10:00:00Z",
};

const episode = {
  id: "abc-123",
  title: "Sunday morning",
  notes: "Philippians 4:10-20",
  length: 5400,
  publishedAt: "2026-09-06T09:30:00Z",
  enclosureUrl: "https://portal.example.com/api/feed/tok/abc-123.mp4",
};

describe("escapeXml", () => {
  it("escapes all five XML metacharacters", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("escapes the ampersand first, not twice", () => {
    expect(escapeXml("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });

  it("renders null and undefined as empty, not as the words", () => {
    expect(escapeXml(null)).toBe("");
    expect(escapeXml(undefined)).toBe("");
  });
});

describe("rfc822", () => {
  it("formats in the shape RSS requires", () => {
    expect(rfc822("2026-09-06T09:30:00Z")).toBe("Sun, 06 Sep 2026 09:30:00 GMT");
  });

  it("pads single digits", () => {
    expect(rfc822("2026-01-02T03:04:05Z")).toBe("Fri, 02 Jan 2026 03:04:05 GMT");
  });

  it("falls back to the epoch on an unparseable date rather than emitting 'Invalid Date'", () => {
    expect(rfc822("not a date")).toBe("Thu, 01 Jan 1970 00:00:00 GMT");
  });
});

describe("itunesDuration", () => {
  it("uses H:MM:SS past an hour and MM:SS below", () => {
    expect(itunesDuration(5400)).toBe("1:30:00");
    expect(itunesDuration(90)).toBe("1:30");
    expect(itunesDuration(0)).toBe("0:00");
  });

  it("handles junk without producing NaN", () => {
    expect(itunesDuration(null)).toBe("0:00");
    expect(itunesDuration(-5)).toBe("0:00");
    expect(itunesDuration("abc")).toBe("0:00");
  });
});

describe("episodeSummary", () => {
  it("flattens newlines into a single paragraph", () => {
    expect(episodeSummary("One\n\nTwo   three")).toBe("One Two three");
  });

  it("falls back to the title when there are no notes", () => {
    expect(episodeSummary("", "Sunday morning")).toBe("Sunday morning");
    expect(episodeSummary(null, "Sunday morning")).toBe("Sunday morning");
  });

  it("clamps a very long note", () => {
    const summary = episodeSummary("x".repeat(2000), "t");
    expect(summary).toHaveLength(900);
    expect(summary.endsWith("...")).toBe(true);
  });
});

describe("buildPodcastFeed", () => {
  it("produces a well-formed RSS 2.0 document with the iTunes namespace", () => {
    const xml = buildPodcastFeed({ ...base, episodes: [episode] });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"');
    expect(xml).toContain("</rss>");
  });

  it("carries the required atom self link", () => {
    const xml = buildPodcastFeed({ ...base, episodes: [episode] });
    expect(xml).toContain(`href="${base.selfUrl}" rel="self"`);
  });

  // A private per-subscriber feed must not end up in Apple's public directory.
  it("blocks directory listing", () => {
    const xml = buildPodcastFeed({ ...base, episodes: [episode] });
    expect(xml).toContain("<itunes:block>Yes</itunes:block>");
  });

  it("renders one item per episode with its enclosure and duration", () => {
    const xml = buildPodcastFeed({ ...base, episodes: [episode] });
    expect(xml).toContain("<title>Sunday morning</title>");
    expect(xml).toContain(`url="${episode.enclosureUrl}"`);
    expect(xml).toContain("<itunes:duration>1:30:00</itunes:duration>");
    expect(xml).toContain('<guid isPermaLink="false">abc-123</guid>');
    expect(xml).toContain("<pubDate>Sun, 06 Sep 2026 09:30:00 GMT</pubDate>");
  });

  // The failure that takes down every client at once.
  it("escapes a title containing XML metacharacters", () => {
    const xml = buildPodcastFeed({
      ...base,
      episodes: [{ ...episode, title: 'Faith & Works <"the talk">' }],
    });
    expect(xml).toContain("Faith &amp; Works &lt;&quot;the talk&quot;&gt;");
    expect(xml).not.toContain('<"the talk">');
  });

  it("escapes the site name and the notes too", () => {
    const xml = buildPodcastFeed({
      ...base,
      siteName: "Ben & Co",
      episodes: [{ ...episode, notes: "see <this>" }],
    });
    expect(xml).toContain("Ben &amp; Co");
    expect(xml).toContain("see &lt;this&gt;");
  });

  it("is valid with no episodes at all", () => {
    const xml = buildPodcastFeed({ ...base, episodes: [] });
    expect(xml).toContain("<channel>");
    expect(xml).toContain("</rss>");
    expect(xml).not.toContain("<item>");
  });

  it("omits the image element entirely when there is no image", () => {
    const xml = buildPodcastFeed({ ...base, imageUrl: null, episodes: [] });
    expect(xml).not.toContain("<itunes:image");
  });

  // A cheap structural check that every opened tag we emit is closed.
  it("balances its channel and item tags", () => {
    const xml = buildPodcastFeed({ ...base, episodes: [episode, { ...episode, id: "d-2" }] });
    const count = (needle) => xml.split(needle).length - 1;
    expect(count("<item>")).toBe(2);
    expect(count("</item>")).toBe(2);
    expect(count("<channel>")).toBe(1);
    expect(count("</channel>")).toBe(1);
  });
});
