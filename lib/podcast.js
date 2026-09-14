// RSS 2.0 + iTunes feed generation.
//
// PURE MODULE — no Redis, no bunny.net, no session. It takes a already-
// authorized list of episodes and returns a string. Everything about WHO may
// see WHAT is decided before this is called (see pages/api/feed/[token].js),
// which is the point: a feed generator that could decide access would be a
// second, parallel authorization path.
//
// Enclosure URLs handed in here are always this app's own media route, never
// a bunny.net CDN URL — see lib/bunnyMedia.js for why that distinction is
// load-bearing.

const RSS_DATE_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RSS_DATE_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// XML escaping, applied to every interpolated value without exception. Titles
// and notes are admin-authored, but "authored by someone we trust" is not a
// reason to skip escaping — an unescaped ampersand in a video title is enough
// to make a feed unparseable in every podcast client at once.
export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// RFC 822 date, which RSS requires. Built explicitly rather than via
// toUTCString() so the format is pinned by this repo's tests rather than by
// the host's locale behaviour.
export function rfc822(value) {
  const date = value ? new Date(value) : new Date();
  const d = Number.isFinite(date.getTime()) ? date : new Date(0);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${RSS_DATE_DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ` +
    `${RSS_DATE_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`
  );
}

// iTunes wants H:MM:SS (or MM:SS). Same shape as lib/chapters.js's formatter,
// duplicated rather than imported because the two answer to different specs
// and must be free to drift: one is a UI label, this one is a feed field.
export function itunesDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// A podcast description is plain text. Notes may contain newlines; collapse
// them so the field stays a single readable paragraph, and clamp it.
export function episodeSummary(notes, fallback) {
  const text = String(notes || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback || "";
  return text.length > 900 ? `${text.slice(0, 897)}...` : text;
}

// Builds the whole document.
//
// `episodes` are {id, title, notes, length, publishedAt, enclosureUrl}.
// `selfUrl` is the feed's own address — required by the spec as
// <atom:link rel="self"> and used by apps to detect a moved feed.
export function buildPodcastFeed({
  siteName,
  description,
  selfUrl,
  siteUrl,
  imageUrl,
  episodes = [],
  now,
}) {
  const title = siteName || "Video portal";
  const desc = description || `Audio from ${title}.`;
  const built = rfc822(now);

  const items = episodes
    .map((ep) => {
      const summary = episodeSummary(ep.notes, ep.title);
      return `    <item>
      <title>${escapeXml(ep.title)}</title>
      <description>${escapeXml(summary)}</description>
      <itunes:summary>${escapeXml(summary)}</itunes:summary>
      <pubDate>${rfc822(ep.publishedAt)}</pubDate>
      <guid isPermaLink="false">${escapeXml(ep.id)}</guid>
      <itunes:duration>${escapeXml(itunesDuration(ep.length))}</itunes:duration>
      <itunes:explicit>false</itunes:explicit>
      <enclosure url="${escapeXml(ep.enclosureUrl)}" type="video/mp4" length="0" />
    </item>`;
    })
    .join("\n");

  // length="0" on the enclosure: the real byte size is only knowable by asking
  // bunny.net for every rendition on every feed build, which would turn one
  // cheap request into N. Every major podcast client treats 0 as "unknown"
  // and streams anyway. Noted here so the next reader knows it is a choice.
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl || "")}</link>
    <description>${escapeXml(desc)}</description>
    <language>en</language>
    <lastBuildDate>${built}</lastBuildDate>
    <generator>${escapeXml(title)}</generator>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml" />
    <itunes:author>${escapeXml(title)}</itunes:author>
    <itunes:summary>${escapeXml(desc)}</itunes:summary>
    <itunes:explicit>false</itunes:explicit>
    <itunes:block>Yes</itunes:block>
${imageUrl ? `    <itunes:image href="${escapeXml(imageUrl)}" />\n` : ""}${items}
  </channel>
</rss>
`;
}
