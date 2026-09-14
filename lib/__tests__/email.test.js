import { afterEach, describe, expect, it } from "vitest";
import {
  accessRequestEmailTemplate,
  emailEnabled,
  escapeHtml,
  shareEmailTemplate,
  siteName,
} from "../email";

const ENV_KEYS = ["RESEND_API_KEY", "EMAIL_FROM", "SITE_NAME"];
const saved = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("emailEnabled", () => {
  it("is disabled until both RESEND_API_KEY and EMAIL_FROM are set", () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    expect(emailEnabled()).toBe(false);

    process.env.RESEND_API_KEY = "re_test_key";
    expect(emailEnabled()).toBe(false);

    process.env.EMAIL_FROM = "Portal <videos@example.com>";
    expect(emailEnabled()).toBe(true);
  });
});

describe("siteName", () => {
  it("defaults and honors SITE_NAME", () => {
    delete process.env.SITE_NAME;
    expect(siteName()).toBe("Marine Video Portal");
    process.env.SITE_NAME = "Crew Videos";
    expect(siteName()).toBe("Crew Videos");
  });
});

// The admin-set name lives in Redis and is injected by the send functions;
// the templates must use it in preference to the env value, or a renamed
// portal would keep sending emails under its old name.
describe("share email templates honor an injected site name", () => {
  const args = {
    recipient: "someone@example.com",
    videoTitle: "Engine room walkthrough",
    url: "https://example.com/watch/abc",
    expiresAt: "2026-12-01T00:00:00.000Z",
  };

  it("uses the injected name in the subject and body", () => {
    process.env.SITE_NAME = "Env Name";
    const { subject, text, html } = shareEmailTemplate({
      ...args,
      site: "Admin Name",
    });
    expect(subject).toContain("Admin Name");
    expect(subject).not.toContain("Env Name");
    expect(text).toContain("Admin Name");
    expect(html).toContain("Admin Name");
  });

  it("falls back to the env name when none is injected", () => {
    process.env.SITE_NAME = "Env Name";
    expect(shareEmailTemplate(args).subject).toContain("Env Name");
  });
});

describe("escapeHtml", () => {
  it("escapes HTML metacharacters", () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;"
    );
  });
});

describe("shareEmailTemplate", () => {
  const args = {
    recipient: "person@example.com",
    videoTitle: "Docking <b>Drills</b>",
    url: "https://portal.example.com/watch/abc123",
    expiresAt: "2030-01-02T03:04:05.000Z",
  };

  it("includes the link, recipient, and expiry in both html and text", () => {
    const { subject, html, text } = shareEmailTemplate(args);
    expect(subject).toContain("Docking <b>Drills</b>");
    expect(html).toContain(args.url);
    expect(html).toContain("person@example.com");
    expect(text).toContain(args.url);
    expect(text).toContain("person@example.com");
    expect(text).toContain("expires");
  });

  it("escapes HTML in the video title", () => {
    const { html } = shareEmailTemplate(args);
    expect(html).not.toContain("<b>Drills</b>");
    expect(html).toContain("Docking &lt;b&gt;Drills&lt;/b&gt;");
  });

  it("survives a malformed expiry date", () => {
    const { text } = shareEmailTemplate({ ...args, expiresAt: "garbage" });
    expect(text).toContain("expires soon");
  });
});

// The requester's note is free text typed by a signed-in stranger and lands
// in an admin's mail client. It is clamped and control-stripped at the source
// (lib/accessRequests.js); escaping it here as well is the belt to that
// braces — a value is escaped at the template, never on the assumption that
// an earlier layer did it.
describe("accessRequestEmailTemplate", () => {
  const base = {
    requester: "stranger@example.com",
    name: "Sam",
    message: "I come on Sundays",
    adminUrl: "https://portal.example.com/admin",
    site: "Grace Chapel",
  };

  it("names the requester in the subject and body", () => {
    const { subject, text, html } = accessRequestEmailTemplate(base);
    expect(subject).toBe("Grace Chapel — access requested by stranger@example.com");
    expect(text).toContain("Sam (stranger@example.com)");
    expect(html).toContain("Sam (stranger@example.com)");
  });

  it("escapes HTML in the note", () => {
    const { html } = accessRequestEmailTemplate({
      ...base,
      message: '<img src=x onerror="alert(1)">',
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("escapes HTML in the display name too", () => {
    const { html } = accessRequestEmailTemplate({ ...base, name: "<b>Sam</b>" });
    expect(html).not.toContain("<b>Sam</b>");
    expect(html).toContain("&lt;b&gt;Sam&lt;/b&gt;");
  });

  it("says so plainly when there is no note", () => {
    const { text, html } = accessRequestEmailTemplate({ ...base, message: null });
    expect(text).toContain("did not leave a note");
    expect(html).toContain("did not leave a note");
  });

  // There is deliberately no approve-by-link: a link that grants access from
  // an inbox grants it to whoever else can read that inbox.
  it("links to the admin panel, never to an approval action", () => {
    const { html, text } = accessRequestEmailTemplate(base);
    expect(html).toContain("https://portal.example.com/admin");
    expect(text).toContain("https://portal.example.com/admin");
    expect(html).not.toMatch(/approve\?|decision=/i);
  });

  it("degrades to instructions when APP_BASE_URL is not configured", () => {
    const { html, text } = accessRequestEmailTemplate({ ...base, adminUrl: null });
    expect(text).toContain("Viewers tab of the admin panel");
    expect(html).toContain("Viewers tab of the admin panel");
  });
});
