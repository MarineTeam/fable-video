// The one place a podcast-feed request is turned into an answer about what
// the caller may have. Both feed routes go through it — the feed document and
// every episode download — so the two can never drift apart.
//
// This is where the design's central property lives: the token is resolved to
// an email, and then EVERYTHING ELSE is re-derived from Redis, right now, by
// the same functions the website uses. Nothing about the caller's entitlement
// is carried in the token, cached alongside it, or remembered between polls.
//
// So:
//   * remove someone from the viewer list  -> next poll returns 403
//   * restrict their group                 -> next poll drops those episodes
//   * a video passes its expiry            -> next poll drops that episode
//   * an admin turns the feed off          -> next poll returns 404
// ...with no revocation step anywhere, because there is no grant to revoke.
//
// Every failure lands on denial. resolveAccess already fails closed
// (lib/roles.js); this file must not soften that on the way past.
import { emailForToken } from "./feedTokens";
import { resolveAccess } from "./roles";
import { getPodcastSettings } from "./store";

// Resolution outcomes, kept as distinct reasons so the routes can choose
// their own status codes without re-deriving anything.
export const FEED_DENIED = {
  DISABLED: "disabled",
  UNKNOWN_TOKEN: "unknown_token",
  NOT_APPROVED: "not_approved",
  ERROR: "error",
};

// Returns { ok: true, access } or { ok: false, reason }.
export async function resolveFeedRequest(token) {
  let enabled = false;
  try {
    ({ enabled } = await getPodcastSettings());
  } catch (err) {
    // Fail closed. An unreadable setting is not permission to serve.
    console.error("Could not read the podcast setting:", err);
    return { ok: false, reason: FEED_DENIED.ERROR };
  }
  if (!enabled) return { ok: false, reason: FEED_DENIED.DISABLED };

  // emailForToken is itself fail-closed and shape-checks before touching
  // Redis, so a junk token never becomes a lookup.
  const email = await emailForToken(token);
  if (!email) return { ok: false, reason: FEED_DENIED.UNKNOWN_TOKEN };

  let access;
  try {
    access = await resolveAccess(email);
  } catch (err) {
    console.error("Could not resolve access for a feed request:", err);
    return { ok: false, reason: FEED_DENIED.ERROR };
  }
  // resolveAccess returns approved:false on every one of its own error paths,
  // so this single check covers "removed from the viewer list" and "Redis was
  // unreadable" identically — which is the correct conflation here.
  if (!access?.approved) return { ok: false, reason: FEED_DENIED.NOT_APPROVED };

  return { ok: true, access };
}
