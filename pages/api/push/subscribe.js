// Register or remove a browser's Web Push subscription for the logged-in,
// approved viewer (admins count as approved). The subscription object comes
// from the browser's PushManager and is stored keyed by its endpoint.
import { requireApproved } from "../../../lib/guard";
import {
  pushEnabled,
  removePushSubscription,
  savePushSubscription,
} from "../../../lib/push";

export default async function handler(req, res) {
  const email = await requireApproved(req, res);
  if (!email) return;

  if (!pushEnabled()) {
    return res.status(503).json({ error: "Push notifications are not configured" });
  }

  if (req.method === "POST") {
    const subscription = req.body?.subscription;
    if (!subscription?.endpoint) {
      return res.status(400).json({ error: "A push subscription is required" });
    }
    try {
      await savePushSubscription(email, subscription);
      return res.status(201).json({ ok: true });
    } catch (err) {
      console.error("Could not save push subscription:", err);
      return res.status(502).json({ error: "Could not save push subscription" });
    }
  }

  if (req.method === "DELETE") {
    const endpoint = req.body?.endpoint || req.query?.endpoint;
    if (!endpoint) {
      return res.status(400).json({ error: "endpoint is required" });
    }
    try {
      await removePushSubscription(String(endpoint), email);
      return res.json({ ok: true });
    } catch (err) {
      console.error("Could not remove push subscription:", err);
      return res.status(502).json({ error: "Could not remove push subscription" });
    }
  }

  res.setHeader("Allow", "POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
