// Which groups a new upload is granted to, decided BEFORE the video exists.
//
// PURE — no Redis. The upload route calls this with the ids the admin ticked
// and the current group records, and only creates the bunny.net video if the
// answer is ok. Refusing afterwards would leave an orphan video in the library
// for a request that was never going to be honoured.
//
// Why uploads grant at all: a restricted group sees only what it is granted,
// so a new video was live for everyone except the people in the group it was
// meant for, until someone remembered to add it on the Groups tab. Ticking
// the groups on the upload card closes that at the one moment the admin is
// already thinking about who the video is for.
//
// There is deliberately NO stored "default group for new uploads". A default
// grants silently, on every upload, long after whoever set it has forgotten
// it exists — access that nobody chose on the day.
export const MAX_UPLOAD_GROUPS = 20;

// raw: the request's groupIds, untrusted. groupMap: id -> group record, as
// getGroupMap() returns. maxVideosPerGroup: lib/groups.js's cap, passed in so
// this module stays free of the Redis import that file carries. Returns
// { ok: true, groupIds } or { ok: false, status, error }.
export function planUploadGrants(raw, groupMap, { maxVideosPerGroup = Infinity } = {}) {
  if (raw === undefined || raw === null) return { ok: true, groupIds: [] };
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
    return { ok: false, status: 400, error: "groupIds must be a list of group ids" };
  }
  const groupIds = [...new Set(raw.map((id) => id.trim()).filter(Boolean))];
  if (groupIds.length > MAX_UPLOAD_GROUPS) {
    return { ok: false, status: 400, error: `At most ${MAX_UPLOAD_GROUPS} groups per upload` };
  }
  const groups = groupMap || {};
  const unknown = groupIds.filter((id) => !groups[id]);
  if (unknown.length) {
    // A group deleted in another tab between loading the page and dropping
    // the file. Refused rather than skipped: quietly granting fewer groups is
    // how a video ends up invisible to the people it was for.
    return {
      ok: false,
      status: 400,
      error: `${unknown.length} of the chosen groups no longer exist — reload and choose again`,
    };
  }
  // saveGroup keeps only the first maxVideosPerGroup ids, so appending to a full
  // group would store nothing and report nothing. Caught here, before the
  // video exists, rather than discovered by a viewer who never sees it.
  const full = groupIds.filter((id) => (groups[id].videoIds || []).length >= maxVideosPerGroup);
  if (full.length) {
    return {
      ok: false,
      status: 409,
      error: `${full.map((id) => groups[id].name).join(", ")} already grants ${maxVideosPerGroup} videos — grant a collection instead`,
    };
  }
  return { ok: true, groupIds };
}
