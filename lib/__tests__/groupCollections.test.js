// Collection grants: the expansion, and the auto-follow that is the point.
//
// Granting by video means an admin ticks every new upload before a restricted
// viewer can see it — the thing FEATURES.md called out as the gap. Granting by
// collection is only worth having if it AUTO-FOLLOWS, so the test that matters
// is that a video which did not exist when the grant was written is visible
// without anyone touching the group.
import { beforeEach, describe, expect, it, vi } from "vitest";

let groupRecords = {};
let library = [];
let libraryCalls = 0;
let libraryThrows = false;

vi.mock("../redis", () => ({
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => ({
    hgetall: async () => groupRecords,
    hget: async (key, field) => groupRecords[field] || null,
    hset: async (key, payload) => {
      Object.assign(groupRecords, payload);
      return 1;
    },
  }),
}));
vi.mock("../bunny", () => ({
  listAllVideos: async () => {
    libraryCalls += 1;
    if (libraryThrows) throw new Error("bunny down");
    return library;
  },
}));

const { allowedVideoIds, pruneCollectionFromGroups } = await import("../groups");

const group = (patch) => ({
  id: patch.id,
  name: patch.id,
  restricted: true,
  videoIds: [],
  collectionIds: [],
  ...patch,
});

beforeEach(() => {
  groupRecords = {};
  library = [
    { guid: "v1", collectionId: "c1" },
    { guid: "v2", collectionId: "c1" },
    { guid: "v3", collectionId: "c2" },
    { guid: "v4", collectionId: "" },
  ];
  libraryCalls = 0;
  libraryThrows = false;
});

describe("expanding a collection grant", () => {
  it("grants every video in the collection", async () => {
    groupRecords = { a: group({ id: "a", collectionIds: ["c1"] }) };
    expect((await allowedVideoIds(["a"])).sort()).toEqual(["v1", "v2"]);
  });

  it("AUTO-FOLLOWS a video added to the collection later", async () => {
    // The whole reason to grant by collection. Nobody edits the group.
    groupRecords = { a: group({ id: "a", collectionIds: ["c1"] }) };
    expect((await allowedVideoIds(["a"])).sort()).toEqual(["v1", "v2"]);
    library.push({ guid: "v5", collectionId: "c1" });
    expect((await allowedVideoIds(["a"])).sort()).toEqual(["v1", "v2", "v5"]);
  });

  it("unions collection grants with explicit video grants, deduped", async () => {
    groupRecords = { a: group({ id: "a", videoIds: ["v1", "v3"], collectionIds: ["c1"] }) };
    expect((await allowedVideoIds(["a"])).sort()).toEqual(["v1", "v2", "v3"]);
  });

  it("never grants a video that is in NO collection", async () => {
    // The hazard: an empty collectionId on a video matching an empty entry in
    // a grant would hand every uncategorised video to that group. The defence
    // is that an empty entry cannot survive into a stored record at all —
    // normalizeGroup drops it — so this asserts that, rather than asserting
    // the filter and passing for the wrong reason.
    groupRecords = { a: group({ id: "a", collectionIds: ["", null, "c1"] }) };
    expect(await allowedVideoIds(["a"])).toEqual(["v1", "v2"]);

    // ...and with nothing but empty entries, the group grants nothing rather
    // than everything uncategorised.
    groupRecords = { a: group({ id: "a", collectionIds: ["", null] }) };
    expect(await allowedVideoIds(["a"])).toEqual([]);
    // No library read happened, because after normalizing there is no
    // collection grant left to expand.
    expect(libraryCalls).toBe(1);
  });
});

describe("what it costs", () => {
  it("does NOT read the library when no group grants a collection", async () => {
    // A deployment that never uses collection grants must pay nothing for
    // their existence — this is on every access resolution.
    groupRecords = { a: group({ id: "a", videoIds: ["v1"] }) };
    expect(await allowedVideoIds(["a"])).toEqual(["v1"]);
    expect(libraryCalls).toBe(0);
  });

  it("does not read the library for an unrestricted viewer", async () => {
    expect(await allowedVideoIds([])).toBe(null);
    expect(libraryCalls).toBe(0);
  });

  it("THROWS when the library cannot be read, so the caller fails closed", async () => {
    // resolveAccess treats a throw as "deny". A restricted viewer seeing
    // nothing during a bunny outage is the right direction to fail in;
    // returning the explicit video ids alone would silently narrow them,
    // and returning null would hand them the whole library.
    groupRecords = { a: group({ id: "a", collectionIds: ["c1"] }) };
    libraryThrows = true;
    await expect(allowedVideoIds(["a"])).rejects.toThrow();
  });
});

describe("pruneCollectionFromGroups", () => {
  it("drops a deleted collection from every group that granted it", async () => {
    groupRecords = {
      a: group({ id: "a", collectionIds: ["c1", "c2"] }),
      b: group({ id: "b", collectionIds: ["c2"] }),
      c: group({ id: "c", collectionIds: [] }),
    };
    expect(await pruneCollectionFromGroups("c2")).toBe(2);
    expect(groupRecords.a.collectionIds).toEqual(["c1"]);
    expect(groupRecords.b.collectionIds).toEqual([]);
  });

  it("leaves video grants and everything else alone", async () => {
    groupRecords = { a: group({ id: "a", videoIds: ["v1"], collectionIds: ["c1"] }) };
    await pruneCollectionFromGroups("c1");
    expect(groupRecords.a.videoIds).toEqual(["v1"]);
    expect(groupRecords.a.restricted).toBe(true);
  });

  it("does nothing for an unknown or empty id", async () => {
    groupRecords = { a: group({ id: "a", collectionIds: ["c1"] }) };
    expect(await pruneCollectionFromGroups("nope")).toBe(0);
    expect(await pruneCollectionFromGroups("")).toBe(0);
    expect(groupRecords.a.collectionIds).toEqual(["c1"]);
  });
});
