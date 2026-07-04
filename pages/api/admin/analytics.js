// Analytics: total views, 30-day views, watch time, video count, a 30-day
// views chart, and a most-watched list — from bunny.net video stats plus the
// statistics API.
import { requireAdmin } from "../../../lib/guard";
import { getStatistics, listAllVideos } from "../../../lib/bunny";

// bunny.net has returned chart data both as { "date": value } maps and as
// arrays of points; normalize defensively.
function chartPoints(chart) {
  if (!chart) return [];
  if (Array.isArray(chart)) {
    return chart.map((p) => ({
      date: String(p.moment || p.date || "").slice(0, 10),
      value: Number(p.value ?? p.count ?? 0) || 0,
    }));
  }
  if (typeof chart === "object") {
    return Object.entries(chart).map(([date, value]) => ({
      date: String(date).slice(0, 10),
      value: Number(value) || 0,
    }));
  }
  return [];
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - 30 * 24 * 3600 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);

  try {
    const [videos, stats] = await Promise.all([
      listAllVideos(),
      getStatistics({ dateFrom: iso(dateFrom), dateTo: iso(dateTo) }).catch(
        () => null
      ),
    ]);

    const totalViews = videos.reduce((sum, v) => sum + (v.views || 0), 0);
    const mostWatched = [...videos]
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 8)
      .map((v) => ({ id: v.guid, title: v.title || "Untitled", views: v.views || 0 }));

    const chart = chartPoints(stats?.viewsChart).sort((a, b) =>
      a.date.localeCompare(b.date)
    );
    const views30d = chart.reduce((sum, p) => sum + p.value, 0);
    const watchSeconds = chartPoints(stats?.watchTimeChart).reduce(
      (sum, p) => sum + p.value,
      0
    );

    return res.json({
      totalViews,
      views30d,
      watchTimeHours: Math.round((watchSeconds / 3600) * 10) / 10,
      videoCount: videos.length,
      chart,
      mostWatched,
    });
  } catch {
    return res.status(502).json({ error: "Could not load analytics" });
  }
}
