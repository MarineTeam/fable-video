// API route guards. Every /api/admin/* route calls requireCapability (or
// requireAdmin) and returns 403 independently of the server-side page gate.
//
// Authorization is capability-based: a route declares the capability it
// needs (CAP.VIDEOS, CAP.PEOPLE, ...) rather than testing for a role name,
// so re-shaping what a role may do never means auditing scattered
// `role === "admin"` comparisons. See lib/roles.js for the role/capability
// table and for why ADMIN_EMAILS remains an un-demotable seed.
import { auth0 } from "./auth0";
import { blockedByEmailVerification, normalizeEmail } from "./auth";
import { stampLastSeen } from "./store";
import { CAP, hasCapability, resolveAccess } from "./roles";

export async function sessionEmail(req) {
  const session = await auth0.getSession(req);
  const email = session?.user?.email;
  return email ? normalizeEmail(email) : null;
}

// Resolves the session to { email, unverified }. `unverified` is only ever
// true when REQUIRE_VERIFIED_EMAIL is on and the claim didn't pass — it is
// reported separately from "not logged in" so callers can say something
// actionable instead of a bare 401.
export async function sessionIdentity(req) {
  const session = await auth0.getSession(req);
  const email = session?.user?.email;
  if (!email) return { email: null, unverified: false };
  return {
    email: normalizeEmail(email),
    unverified: blockedByEmailVerification(session.user),
  };
}

export async function requireUser(req, res) {
  const { email, unverified } = await sessionIdentity(req);
  if (!email) {
    res.status(401).json({ error: "Login required" });
    return null;
  }
  if (unverified) {
    res
      .status(403)
      .json({ error: "Verify your email address, then sign in again" });
    return null;
  }
  return email;
}

// Resolves the caller's full access record (role, capabilities, group video
// scope). Returns null and has already answered with 401/403 when the caller
// may not see video data at all.
//
// resolveAccess fails closed internally: any Redis error yields "not
// approved", so an infra failure denies access rather than leaking the
// private library. Never change that direction — see architecture-contract
// invariant (c).
export async function requireAccess(req, res) {
  const email = await requireUser(req, res);
  if (!email) return null;
  const access = await resolveAccess(email);
  if (!access.approved) {
    res.status(403).json({ error: "Your account is not approved to view videos" });
    return null;
  }
  stampLastSeen(email);
  return access;
}

// Back-compat shape for routes that only need "an approved person's email".
export async function requireApproved(req, res) {
  const access = await requireAccess(req, res);
  return access ? access.email : null;
}

// Authorizes one capability. Returns the full access record so a handler can
// also consult the caller's role or video scope without a second lookup.
export async function requireCapability(req, res, capability) {
  const email = await requireUser(req, res);
  if (!email) return null;
  const access = await resolveAccess(email);
  if (!hasCapability(access, capability)) {
    res.status(403).json({ error: "You don't have permission to do that" });
    return null;
  }
  stampLastSeen(email);
  return access;
}

// Full-admin gate, for the routes that manage people or site settings.
// Kept as a named guard so "which routes need a full admin?" stays greppable.
export async function requireAdmin(req, res) {
  const access = await requireCapability(req, res, CAP.PEOPLE);
  return access ? access.email : null;
}
