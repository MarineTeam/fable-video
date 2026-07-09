// Viewer-facing video library for approved viewers — ordered, ready-only,
// capped at the admin-configured homepage count. Search, collection
// filtering, and pagination happen client-side against this list, so this
// endpoint is only hit once per page load (not per keystroke). Rate-limited;
// the underlying bunny.net call is itself cached briefly (lib/bunny.js).
import { requireApproved } from "../../lib/guard";
import { allowRequest } from "../../lib/ratelimit";
import { fetchVideoLibrary } from "../../lib/videoList";

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
    const data = await fetchVideoLibrary();
    return res.json(data);
  } catch (err) {
    console.error("Could not load the video library:", err);
    return res.status(502).json({ error: "Could not load the video library" });
  }
}
