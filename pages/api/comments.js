// Comments under a video.
//
//   GET    ?videoId=...             -> { comments: [...] }, oldest first
//   POST   { videoId, text }        -> { comment } — added as the caller
//   DELETE ?videoId=...&id=...      -> removes one comment
//
// GATED LIKE WATCHING. Reading, writing and deleting all require the video to
// be in the caller's group scope (scopeAllows, 404 otherwise — a 200 would
// answer "does this id exist?"). Reading and writing also require its publish
// window (viewerMayActOn): comments on a talk that is not out yet, or has been
// taken down, are not for viewers. Deleting your own comment is always
// allowed, as un-voting is — a viewer must be able to take back what they said.
//
// IDENTITY COMES FROM THE SESSION. There is no email parameter anywhere; the
// author is the caller, and "is this mine?" is decided by the stored email.
// Other viewers see a display name only (lib/comments.js); the email is shown
// solely to a caller who can already read the viewer list (viewers.read).
//
// MODERATION: a comment appears at once. Its author may delete it, and so may
// anyone holding comments.manage; a moderator deleting someone else's comment
// is audited, since it removes words a person wrote.
import { auth0 } from "../../lib/auth0";
import { logAction } from "../../lib/audit";
import { CAP, hasCapability } from "../../lib/capabilities";
import { cleanCommentText, commentView, displayName } from "../../lib/comments";
import { addComment, deleteComment, getComment, listComments } from "../../lib/commentsStore";
import { requireAccess } from "../../lib/guard";
import { withMonitorApi } from "../../lib/monitor";
import { oneTrimmed } from "../../lib/params";
import { allowRequest } from "../../lib/ratelimit";
import { scopeAllows } from "../../lib/roles";
import { viewerMayActOn } from "../../lib/schedule";

async function handler(req, res) {
  const access = await requireAccess(req, res);
  if (!access) return;

  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const videoId =
    req.method === "POST" ? oneTrimmed(req.body?.videoId) : oneTrimmed(req.query.videoId);
  if (!videoId) return res.status(400).json({ error: "Video id is required" });
  if (!scopeAllows(access.videoScope, videoId)) {
    return res.status(404).json({ error: "Not found" });
  }

  const canModerate = hasCapability(access, CAP.COMMENTS_MANAGE);
  const viewOptions = {
    email: access.email,
    canModerate,
    canSeeEmails: hasCapability(access, CAP.VIEWERS_READ),
  };

  if (req.method === "GET") {
    if (!(await viewerMayActOn(access, videoId))) {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      const comments = await listComments(videoId);
      return res.json({ comments: comments.map((c) => commentView(c, viewOptions)) });
    } catch (err) {
      console.error("Could not read comments:", err);
      return res.status(502).json({ error: "Could not load comments" });
    }
  }

  // Writes are rate limited per person: cheap each, unbounded in aggregate,
  // and reachable by anyone approved.
  if (!(await allowRequest("comment", access.email, 30, "1 h"))) {
    return res.status(429).json({ error: "Too many comments — try again later" });
  }

  if (req.method === "POST") {
    if (!(await viewerMayActOn(access, videoId))) {
      return res.status(404).json({ error: "Not found" });
    }
    const cleaned = cleanCommentText(req.body?.text);
    if (!cleaned.ok) return res.status(400).json({ error: cleaned.error });

    let profileName = "";
    try {
      profileName = (await auth0.getSession(req))?.user?.name || "";
    } catch (err) {
      // The name falls back to the email's local part; the comment still posts.
      console.error("Could not read the profile name for a comment:", err);
    }

    try {
      const result = await addComment(videoId, {
        email: access.email,
        name: displayName(profileName, access.email),
        text: cleaned.text,
      });
      if (!result.ok) {
        return res.status(409).json({ error: "This video has reached its comment limit" });
      }
      return res.json({ comment: commentView(result.comment, viewOptions) });
    } catch (err) {
      console.error("Could not save a comment:", err);
      return res.status(502).json({ error: "Could not save your comment" });
    }
  }

  // DELETE
  const id = oneTrimmed(req.query.id);
  let comment;
  try {
    comment = await getComment(videoId, id);
  } catch (err) {
    console.error("Could not read a comment:", err);
    return res.status(502).json({ error: "Could not delete the comment" });
  }
  if (!comment) return res.status(404).json({ error: "Not found" });

  const mine = comment.email === access.email;
  if (!mine && !canModerate) {
    return res.status(403).json({ error: "You can only delete your own comments" });
  }
  try {
    await deleteComment(videoId, comment.id);
  } catch (err) {
    console.error("Could not delete a comment:", err);
    return res.status(502).json({ error: "Could not delete the comment" });
  }
  if (!mine) {
    await logAction(access.email, "comment.delete", `${videoId}: a comment by ${comment.name}`);
  }
  return res.json({ ok: true });
}

export default withMonitorApi(handler);
