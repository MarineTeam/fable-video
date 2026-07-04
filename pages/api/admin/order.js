// Custom homepage video order (drag-to-reorder in the admin panel).
import { requireAdmin } from "../../../lib/guard";
import { getOrder, saveOrder } from "../../../lib/store";
import { logAction } from "../../../lib/audit";

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === "GET") {
    try {
      return res.json({ order: await getOrder() });
    } catch {
      return res.status(502).json({ error: "Could not load the video order" });
    }
  }

  if (req.method === "POST") {
    const order = req.body?.order;
    if (
      !Array.isArray(order) ||
      order.length > 1000 ||
      order.some((id) => typeof id !== "string" || !id || id.length > 100)
    ) {
      return res.status(400).json({ error: "Order must be an array of video ids" });
    }
    try {
      await saveOrder(order);
    } catch {
      return res.status(502).json({ error: "Could not save the video order" });
    }
    await logAction(admin, "order.update", `${order.length} videos`);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
