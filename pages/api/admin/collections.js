// Collections: create, list, delete (videos in a deleted collection stay in
// the library, just unassigned).
import { requireAdmin } from "../../../lib/guard";
import { createCollection, deleteCollection, listCollections } from "../../../lib/bunny";
import { logAction } from "../../../lib/audit";

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === "GET") {
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

  if (req.method === "POST") {
    const name = String(req.body?.name || "").trim();
    if (!name || name.length > 100) {
      return res.status(400).json({ error: "Name must be 1-100 characters" });
    }
    let collection;
    try {
      collection = await createCollection(name);
    } catch {
      return res.status(502).json({ error: "Could not create the collection" });
    }
    await logAction(admin, "collection.create", name);
    return res.status(201).json({ collection: { id: collection.guid, name } });
  }

  if (req.method === "DELETE") {
    const id = String(req.query.id || "");
    if (!id) return res.status(400).json({ error: "Collection id is required" });
    try {
      await deleteCollection(id);
    } catch {
      return res.status(502).json({ error: "Could not delete the collection" });
    }
    await logAction(admin, "collection.delete", id);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
