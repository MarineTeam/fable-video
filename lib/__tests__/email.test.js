import { afterEach, describe, expect, it } from "vitest";
import { emailEnabled, escapeHtml, shareEmailTemplate, siteName } from "../email";

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
