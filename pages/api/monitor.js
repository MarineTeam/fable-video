// Lightweight process stats for the Query Monitor panel (memory, uptime).
// 404s outright when the feature is off, so its existence isn't even
// observable from the network tab on a deployment that hasn't opted in.
// Requires a session (any signed-in user, not admin-only) so perf details
// about the server process are never exposed to a logged-out visitor.
import { requireUser } from "../../lib/guard";
import { monitorEnabled } from "../../lib/monitor";

export default async function handler(req, res) {
  if (!monitorEnabled()) return res.status(404).json({ enabled: false });

  const email = await requireUser(req, res);
  if (!email) return;

  const mem = process.memoryUsage();
  return res.json({
    enabled: true,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    },
    // NB: on Vercel each API route is its own serverless function, so these
    // describe whichever instance happened to answer THIS request — not the
    // one that rendered the page — and uptime resets on every cold start.
    // The client labels them per-instance so the numbers aren't misread as
    // fleet-wide.
    uptime: process.uptime(),
    serverless: Boolean(process.env.VERCEL),
    node: process.version,
  });
}
