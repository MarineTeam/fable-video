// Collection list for the homepage filter chips (approved viewers).
import { requireApproved } from "../../lib/guard";
import { listCollections } from "../../lib/bunny";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const email = await requireApproved(req, res);
  if (!email) return;

  try {
    const collections = await listCollections();
    return res.json({
      collections: collections.map((c) => ({
        id: c.guid,
        name: c.name || "Untitled",
        videoCount: c.videoCount || 0,
      })),
    });
  } catch {
    return res.status(502).json({ error: "Could not load collections" });
  }
}
