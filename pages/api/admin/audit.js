// Recent admin actions (activity log).
import { requireCapability } from "../../../lib/guard";
import { CAP } from "../../../lib/roles";
import { recentActions } from "../../../lib/audit";
import { withMonitorApi } from "../../../lib/monitor";

async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const access = await requireCapability(req, res, CAP.INSIGHTS);
  if (!access) return;
  const admin = access.email;

  try {
    return res.json({ actions: await recentActions(100) });
  } catch (err) {
    console.error("Could not load the activity log:", err);
    return res.status(502).json({ error: "Could not load the activity log" });
  }
}

export default withMonitorApi(handler);
