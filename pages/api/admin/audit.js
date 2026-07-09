// Recent admin actions (activity log).
import { requireAdmin } from "../../../lib/guard";
import { recentActions } from "../../../lib/audit";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    return res.json({ actions: await recentActions(100) });
  } catch (err) {
    console.error("Could not load the activity log:", err);
    return res.status(502).json({ error: "Could not load the activity log" });
  }
}
