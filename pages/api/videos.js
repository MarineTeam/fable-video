// Paginated video library for approved viewers, with title search and
// collection filtering. Rate-limited; only ready (fully encoded) videos are
// returned, capped at the admin-configured homepage count and sorted by the
// admin's custom order (new uploads float to the top).
import { requireApproved } from "../../lib/guard";
import { allowRequest } from "../../lib/ratelimit";
import { fetchVideoPage } from "../../lib/videoList";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const email = await requireApproved(req, res);
  if (!email) return;

  if (!(await allowRequest("videos", email, 60, "1 m"))) {
    return res.status(429).json({ error: "Too many requests — slow down a little" });
  }

  try {
    const data = await fetchVideoPage({
      page: parseInt(req.query.page, 10) || 1,
      q: String(req.query.q || ""),
      collection: String(req.query.collection || ""),
    });
    return res.json(data);
  } catch {
    return res.status(502).json({ error: "Could not load the video library" });
  }
}
