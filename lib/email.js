// Automatic email delivery of private share links, via the Resend REST API
// (https://resend.com — works out of the box on Vercel, no SDK needed).
// Inert until RESEND_API_KEY and EMAIL_FROM are configured: share creation
// still works and the admin falls back to copying the link manually.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const env = (name) => (process.env[name] || "").trim();

export function emailEnabled() {
  return Boolean(env("RESEND_API_KEY") && env("EMAIL_FROM"));
}

export function emailFrom() {
  return env("EMAIL_FROM") || null;
}

export function siteName() {
  return env("SITE_NAME") || "Marine Video Portal";
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendEmail({ to, subject, html, text }) {
  if (!emailEnabled()) {
    throw new Error("Email is not configured (set RESEND_API_KEY and EMAIL_FROM)");
  }
  const payload = { from: env("EMAIL_FROM"), to: [to], subject, html, text };
  const replyTo = env("EMAIL_REPLY_TO");
  if (replyTo) payload.reply_to = replyTo;

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let message = `status ${res.status}`;
    try {
      const data = await res.json();
      if (data?.message) message = data.message;
    } catch {
      // keep the status-based message
    }
    throw new Error(`Email delivery failed: ${message}`);
  }
  return res.json();
}

export function shareEmailTemplate({ recipient, videoTitle, url, expiresAt }) {
  const site = siteName();
  const expires = new Date(expiresAt);
  const expiresText = Number.isNaN(expires.getTime())
    ? "soon"
    : expires.toUTCString();

  const subject = `${site} — a video has been shared with you: ${videoTitle}`;

  const text = [
    `A video on ${site} has been shared with you.`,
    "",
    `Video: ${videoTitle}`,
    `Watch it here: ${url}`,
    "",
    `This private link expires ${expiresText}.`,
    `It only works when you sign in as ${recipient}.`,
    "",
    "If you were not expecting this, you can ignore this email.",
  ].join("\n");

  const safeTitle = escapeHtml(videoTitle);
  const safeRecipient = escapeHtml(recipient);
  const safeUrl = escapeHtml(url);
  const safeSite = escapeHtml(site);

  const html = `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
            <tr>
              <td style="background-color:#0f172a;padding:20px 32px;">
                <span style="color:#e2e8f0;font-size:16px;font-weight:bold;letter-spacing:0.4px;">${safeSite}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 8px;color:#475569;font-size:14px;">A video has been shared with you.</p>
                <h1 style="margin:0 0 24px;color:#0f172a;font-size:22px;line-height:1.3;">${safeTitle}</h1>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                  <tr>
                    <td style="border-radius:8px;background-color:#0284c7;">
                      <a href="${safeUrl}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;">Watch the video</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 6px;color:#64748b;font-size:13px;line-height:1.6;">
                  This private link expires <strong>${escapeHtml(expiresText)}</strong>.
                </p>
                <p style="margin:0 0 6px;color:#64748b;font-size:13px;line-height:1.6;">
                  It only works when you sign in as <strong>${safeRecipient}</strong>.
                </p>
                <p style="margin:16px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;">
                  If the button does not work, copy this address into your browser:<br />
                  <a href="${safeUrl}" style="color:#0284c7;word-break:break-all;">${safeUrl}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;background-color:#f8fafc;border-top:1px solid #e2e8f0;">
                <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
                  This message was sent automatically by ${safeSite}. If you were not expecting it, you can safely ignore it.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}

export async function sendShareEmail({ recipient, videoTitle, url, expiresAt }) {
  const { subject, html, text } = shareEmailTemplate({
    recipient,
    videoTitle,
    url,
    expiresAt,
  });
  return sendEmail({ to: recipient, subject, html, text });
}
