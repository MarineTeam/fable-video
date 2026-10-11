// What is deleted when a viewer is removed (pages/api/admin/viewers.js).
//
// Decided by the owner (2026-10-11): removing someone deletes what was
// recorded about them — their votes (taken back out of the totals), their
// watch progress, their saved list and their comments. Re-adding them later
// starts them from nothing.
//
// The route calls this BEFORE taking their access away. If any part fails it
// throws, the route answers 502 and they stay on the list, so the admin can
// simply remove them again — run after the removal, a failure would leave data
// nothing could ever find again.
//
// EVERY per-viewer key family belongs here. Adding one and forgetting this is
// exactly how the gap this closes came about.
import { deleteCommentsBy } from "./commentsStore";
import { forgetViewerRecords } from "./store";

export async function forgetViewerData(email) {
  const { votes } = await forgetViewerRecords(email);
  const comments = await deleteCommentsBy(email);
  return { votes, comments };
}
