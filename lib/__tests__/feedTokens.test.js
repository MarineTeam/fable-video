// Feed tokens are bearer strings that live in podcast apps for years, so the
// properties worth pinning are: they are big and random, a malformed one
// never becomes a Redis lookup, resolution fails closed, and rotating one
// actually kills the old URL rather than leaving it working.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hget = vi.fn();
const hset = vi.fn();
const hdel = vi.fn();

vi.mock("../redis", () => ({
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => ({ hget, hset, hdel }),
}));

const {
  TOKEN_BYTES,
  deleteFeedToken,
  emailForToken,
  ensureFeedToken,
  feedUrl,
  generateToken,
  isFeedToken,
  rotateFeedToken,
} = await import("../feedTokens");

const BY_TOKEN = "fablevideo:feed:tokens";
const BY_EMAIL = "fablevideo:feed:byemail";

beforeEach(() => {
  vi.clearAllMocks();
  // @upstash/redis is promise-returning for every command; the stubs have to
  // be too, or a test failure is just an incomplete fake rather than a bug.
  hget.mockResolvedValue(null);
  hset.mockResolvedValue(1);
  hdel.mockResolvedValue(1);
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.APP_BASE_URL = "https://portal.example.com";
});

describe("generateToken", () => {
  it("is 256 bits of randomness", () => {
    expect(TOKEN_BYTES).toBe(32);
    const token = generateToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("is base64url — safe in a path with no escaping", () => {
    for (let i = 0; i < 50; i += 1) {
      const token = generateToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(encodeURIComponent(token)).toBe(token);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(seen.size).toBe(200);
  });
});

describe("isFeedToken", () => {
  it("accepts a generated token", () => {
    expect(isFeedToken(generateToken())).toBe(true);
  });

  it("rejects anything the wrong shape", () => {
    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), null, undefined, 42, {}, "../../etc/passwd", `${"a".repeat(42)}/`]) {
      expect(isFeedToken(bad)).toBe(false);
    }
  });
});

describe("emailForToken", () => {
  it("resolves a known token", async () => {
    const token = generateToken();
    hget.mockResolvedValue("Crew@Example.com");
    expect(await emailForToken(token)).toBe("crew@example.com");
    expect(hget).toHaveBeenCalledWith(BY_TOKEN, token);
  });

  it("returns null for an unknown token", async () => {
    hget.mockResolvedValue(null);
    expect(await emailForToken(generateToken())).toBeNull();
  });

  // Shape-checked before Redis, so a junk path costs nothing and can't be
  // used to probe.
  it("never touches Redis for a malformed token", async () => {
    expect(await emailForToken("nope")).toBeNull();
    expect(await emailForToken("../admin")).toBeNull();
    expect(hget).not.toHaveBeenCalled();
  });

  it("returns null when Redis throws — fails closed", async () => {
    hget.mockRejectedValue(new Error("redis is down"));
    expect(await emailForToken(generateToken())).toBeNull();
  });
});

describe("rotateFeedToken", () => {
  it("writes both directions and deletes the previous token", async () => {
    hget.mockResolvedValue("old-token-value");
    const token = await rotateFeedToken("crew@example.com");
    expect(hset).toHaveBeenCalledWith(BY_TOKEN, { [token]: "crew@example.com" });
    expect(hset).toHaveBeenCalledWith(BY_EMAIL, { "crew@example.com": token });
    // The old URL must stop working; a surviving row is a live feed.
    expect(hdel).toHaveBeenCalledWith(BY_TOKEN, "old-token-value");
  });

  it("issues a different token each time", async () => {
    hget.mockResolvedValue(null);
    const a = await rotateFeedToken("crew@example.com");
    const b = await rotateFeedToken("crew@example.com");
    expect(a).not.toBe(b);
  });

  it("normalizes the email it stores against", async () => {
    hget.mockResolvedValue(null);
    const token = await rotateFeedToken("  Crew@Example.COM ");
    expect(hset).toHaveBeenCalledWith(BY_TOKEN, { [token]: "crew@example.com" });
  });
});

describe("ensureFeedToken", () => {
  it("returns the existing token rather than churning it", async () => {
    const existing = generateToken();
    hget.mockResolvedValue(existing);
    expect(await ensureFeedToken("crew@example.com")).toBe(existing);
    expect(hset).not.toHaveBeenCalled();
  });

  it("mints one on first use", async () => {
    hget.mockResolvedValue(null);
    const token = await ensureFeedToken("crew@example.com");
    expect(isFeedToken(token)).toBe(true);
    expect(hset).toHaveBeenCalled();
  });

  // A stored value that isn't a valid token must not be handed back as a URL.
  it("replaces a corrupt stored value", async () => {
    hget.mockResolvedValue("garbage");
    const token = await ensureFeedToken("crew@example.com");
    expect(isFeedToken(token)).toBe(true);
  });
});

describe("deleteFeedToken", () => {
  it("removes both rows", async () => {
    hget.mockResolvedValue("the-token");
    await deleteFeedToken("crew@example.com");
    expect(hdel).toHaveBeenCalledWith(BY_TOKEN, "the-token");
    expect(hdel).toHaveBeenCalledWith(BY_EMAIL, "crew@example.com");
  });

  it("does not throw when there is nothing to remove", async () => {
    hget.mockResolvedValue(null);
    await expect(deleteFeedToken("nobody@example.com")).resolves.toBeUndefined();
  });
});

describe("feedUrl", () => {
  it("builds the subscriber's address", () => {
    const token = generateToken();
    expect(feedUrl(token)).toBe(`https://portal.example.com/api/feed/${token}`);
  });

  it("returns null for a malformed token or missing base url", () => {
    expect(feedUrl("nope")).toBeNull();
    delete process.env.APP_BASE_URL;
    expect(feedUrl(generateToken())).toBeNull();
  });
});
