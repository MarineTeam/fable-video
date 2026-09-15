// The notification itself. Three properties are worth pinning, and all three
// are the kind that fail silently in production:
//
//   1. it is addressed, not broadcast — a push about a named stranger must
//      never reach every approved viewer;
//   2. it is inert until configured — no keys means no sends and no errors;
//   3. it is best-effort — a delivery failure is swallowed, never rethrown
//      into the request that created the access request.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  emailEnabled,
  sendAccessRequestEmail,
  pushEnabled,
  sendPushToEmails,
  sendPushToApproved,
  emailsHoldingCapability,
} = vi.hoisted(() => ({
  emailEnabled: vi.fn(),
  sendAccessRequestEmail: vi.fn(),
  pushEnabled: vi.fn(),
  sendPushToEmails: vi.fn(),
  sendPushToApproved: vi.fn(),
  emailsHoldingCapability: vi.fn(),
}));

vi.mock("../email", () => ({ emailEnabled, sendAccessRequestEmail }));
vi.mock("../push", () => ({ pushEnabled, sendPushToEmails, sendPushToApproved }));
vi.mock("../roles", () => ({
  CAP: { VIEWERS_MANAGE: "viewers.manage" },
  emailsHoldingCapability,
}));

const { notifyNewAccessRequest } = await import("../accessRequestNotify");

const request = {
  email: "stranger@example.com",
  name: "Sam",
  message: "I come on Sundays",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_BASE_URL = "https://portal.example.com";
  emailEnabled.mockReturnValue(true);
  pushEnabled.mockReturnValue(true);
  emailsHoldingCapability.mockResolvedValue(["root@example.com", "boss@example.com"]);
  sendAccessRequestEmail.mockResolvedValue({});
  sendPushToEmails.mockResolvedValue({ sent: 2, pruned: 0, configured: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("who it reaches", () => {
  it("emails every holder of the viewers-manage capability", async () => {
    await notifyNewAccessRequest(request);
    expect(emailsHoldingCapability).toHaveBeenCalledWith("viewers.manage");
    expect(sendAccessRequestEmail).toHaveBeenCalledTimes(2);
    expect(sendAccessRequestEmail.mock.calls.map(([a]) => a.to).sort()).toEqual([
      "boss@example.com",
      "root@example.com",
    ]);
  });

  // The one that would be a leak: sendPushToApproved goes to every approved
  // viewer, which would tell the whole portal that a named stranger asked.
  it("pushes only to those recipients, never to every approved viewer", async () => {
    await notifyNewAccessRequest(request);
    expect(sendPushToEmails).toHaveBeenCalledTimes(1);
    expect(sendPushToEmails.mock.calls[0][0]).toEqual([
      "root@example.com",
      "boss@example.com",
    ]);
    expect(sendPushToApproved).not.toHaveBeenCalled();
  });

  // The note is free text from a signed-in stranger. It belongs in the email,
  // not on a lock screen readable by anyone holding the phone.
  it("keeps the requester's note out of the push body", async () => {
    await notifyNewAccessRequest(request);
    const payload = sendPushToEmails.mock.calls[0][1];
    expect(payload.body).toContain("stranger@example.com");
    expect(payload.body).not.toContain("I come on Sundays");
    expect(payload.url.startsWith("/")).toBe(true);
  });

  it("sends nothing when nobody holds the capability", async () => {
    emailsHoldingCapability.mockResolvedValue([]);
    await notifyNewAccessRequest(request);
    expect(sendAccessRequestEmail).not.toHaveBeenCalled();
    expect(sendPushToEmails).not.toHaveBeenCalled();
  });
});

describe("inert until configured", () => {
  it("does nothing at all with neither email nor push configured", async () => {
    emailEnabled.mockReturnValue(false);
    pushEnabled.mockReturnValue(false);
    const result = await notifyNewAccessRequest(request);
    expect(emailsHoldingCapability).not.toHaveBeenCalled();
    expect(result).toEqual({ emailed: 0, pushed: 0, recipients: 0 });
  });

  it("still pushes when only push is configured", async () => {
    emailEnabled.mockReturnValue(false);
    await notifyNewAccessRequest(request);
    expect(sendAccessRequestEmail).not.toHaveBeenCalled();
    expect(sendPushToEmails).toHaveBeenCalledTimes(1);
  });

  it("still emails when only email is configured", async () => {
    pushEnabled.mockReturnValue(false);
    await notifyNewAccessRequest(request);
    expect(sendAccessRequestEmail).toHaveBeenCalledTimes(2);
    expect(sendPushToEmails).not.toHaveBeenCalled();
  });
});

describe("best-effort", () => {
  it("does not throw when every email fails", async () => {
    sendAccessRequestEmail.mockRejectedValue(new Error("resend is down"));
    const result = await notifyNewAccessRequest(request);
    expect(result.emailed).toBe(0);
  });

  it("delivers to the rest when one address fails", async () => {
    sendAccessRequestEmail
      .mockRejectedValueOnce(new Error("bounced"))
      .mockResolvedValueOnce({});
    const result = await notifyNewAccessRequest(request);
    expect(result.emailed).toBe(1);
  });

  it("does not throw when push fails", async () => {
    sendPushToEmails.mockRejectedValue(new Error("vapid rejected"));
    const result = await notifyNewAccessRequest(request);
    expect(result.pushed).toBe(0);
  });

  it("does not throw when the recipient lookup fails", async () => {
    emailsHoldingCapability.mockRejectedValue(new Error("redis is down"));
    const result = await notifyNewAccessRequest(request);
    expect(result).toEqual({ emailed: 0, pushed: 0, recipients: 0 });
    expect(sendAccessRequestEmail).not.toHaveBeenCalled();
  });

  it("ignores a null request — there is nothing to announce", async () => {
    await notifyNewAccessRequest(null);
    expect(emailsHoldingCapability).not.toHaveBeenCalled();
  });
});
