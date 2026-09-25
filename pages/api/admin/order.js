// Custom homepage video order (drag-to-reorder in the admin panel).
import { requireCapability } from "../../../lib/guard";
import { CAP } from "../../../lib/roles";
import { getOrder, saveOrder } from "../../../lib/store";
import { logAction } from "../../../lib/audit";
import { withMonitorApi } from "../../../lib/monitor";
import { SCOPED_REFUSAL } from "../../../lib/staffScope";
import { isScoped, videoInScope } from "../../../lib/staffScopeRules";

async function handler(req, res) {
  const access = await requireCapability(req, res, CAP.VIDEOS_MANAGE);
  if (!access) return;
  const admin = access.email;

  if (req.method === "GET") {
    try {
      // A scoped caller sees only their own videos' places in it.
      const order = await getOrder();
      return res.json({ order: order.filter((id) => videoInScope(access, id)) });
    } catch (err) {
      console.error("Could not load the video order:", err);
      return res.status(502).json({ error: "Could not load the video order" });
    }
  }

  if (req.method === "POST") {
    // The homepage order is one list for everyone.
    if (isScoped(access)) return res.status(403).json({ error: SCOPED_REFUSAL });
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
    } catch (err) {
      console.error("Could not save the video order:", err);
      return res.status(502).json({ error: "Could not save the video order" });
    }
    await logAction(admin, "order.update", `${order.length} videos`);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
