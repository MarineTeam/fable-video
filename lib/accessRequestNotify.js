// Tells the people who can action an access request that one has arrived.
//
// Until now an admin only learned of a pending request by happening to visit
// the Access tab. This closes that gap without changing what a request IS: it
// still grants nothing, and this module never writes anything.
//
// Three properties this file exists to guarantee:
//
//  1. BEST-EFFORT. Every path is wrapped so a mail or push failure can never
//     fail the submission it describes. The requester's ask is the product;
//     the notification is a convenience. Callers get a summary back and are
//     expected to ignore it.
//  2. INERT UNTIL CONFIGURED. No Resend key means no email; no VAPID keys
//     mean no push; neither means no errors and no user-visible difference.
//     Same posture as lib/email.js and lib/push.js already take.
//  3. ADDRESSED, NOT BROADCAST. Recipients are derived from who holds the
//     people-management capability (CAP.PEOPLE) — today that is admins and
//     the ADMIN_EMAILS seed, since the role table grants CAP.PEOPLE to admin
//     alone. Deriving it from the capability rather than hardcoding "admins"
//     means that if the table ever changes, the recipients follow it.
//     Push goes through sendPushToEmails, never sendPushToApproved: every
//     approved viewer does not need to know that a named stranger asked.
import { CAP, capabilityHolders } from "./roles";
import { emailEnabled, sendAccessRequestEmail } from "./email";
import { pushEnabled, sendPushToEmails } from "./push";

// The access-request queue lives on the Viewers tab of /admin. Tabs there are
// React state rather than routes, so there is no deep link to offer — /admin
// is as specific as this can honestly be.
function adminUrl() {
  const base = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  return base ? `${base}/admin` : null;
}

// `request` is the record createAccessRequest returned. That function returns
// null when a request already exists, so passing its result straight through
// is what keeps a refresh loop from becoming a notification flood — a re-ask
// while one is pending has nothing to announce.
export async function notifyNewAccessRequest(request) {
  const summary = { emailed: 0, pushed: 0, recipients: 0 };
  if (!request?.email) return summary;
  if (!emailEnabled() && !pushEnabled()) return summary;

  let recipients = [];
  try {
    recipients = await capabilityHolders(CAP.PEOPLE);
  } catch (err) {
    console.error("Could not resolve access-request notification recipients:", err);
    return summary;
  }
  if (!recipients.length) return summary;
  summary.recipients = recipients.length;

  const { email: requester, name, message } = request;

  if (emailEnabled()) {
    // Per recipient, so one bad address cannot take the rest down with it.
    const results = await Promise.allSettled(
      recipients.map((to) =>
        sendAccessRequestEmail({ to, requester, name, message, adminUrl: adminUrl() })
      )
    );
    for (const result of results) {
      if (result.status === "fulfilled") summary.emailed += 1;
      else console.error("Access-request email failed:", result.reason);
    }
  }

  if (pushEnabled()) {
    try {
      const result = await sendPushToEmails(recipients, {
        title: "Access requested",
        // The requester's address only; the note is not repeated on a lock
        // screen, where it would be readable by anyone holding the phone.
        body: `${requester} has asked for access`,
        url: "/admin",
      });
      summary.pushed = result.sent;
    } catch (err) {
      console.error("Access-request push failed:", err);
    }
  }

  return summary;
}
