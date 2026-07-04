// API route guards. Every /api/admin/* route calls requireAdmin and returns
// 403 for non-admins independently of the server-side page gate.
import { auth0 } from "./auth0";
import { isAdmin, normalizeEmail } from "./auth";
import { isApprovedViewer, stampLastSeen } from "./store";

export async function sessionEmail(req) {
  const session = await auth0.getSession(req);
  const email = session?.user?.email;
  return email ? normalizeEmail(email) : null;
}

export async function requireUser(req, res) {
  const email = await sessionEmail(req);
  if (!email) {
    res.status(401).json({ error: "Login required" });
    return null;
  }
  return email;
}

export async function requireApproved(req, res) {
  const email = await requireUser(req, res);
  if (!email) return null;
  if (isAdmin(email)) return email;
  let approved = false;
  try {
    approved = await isApprovedViewer(email);
  } catch {
    // Approval fails closed — no video data leaks on an infra error.
    approved = false;
  }
  if (!approved) {
    res.status(403).json({ error: "Your account is not approved to view videos" });
    return null;
  }
  stampLastSeen(email);
  return email;
}

export async function requireAdmin(req, res) {
  const email = await requireUser(req, res);
  if (!email) return null;
  if (!isAdmin(email)) {
    res.status(403).json({ error: "Admins only" });
    return null;
  }
  return email;
}
