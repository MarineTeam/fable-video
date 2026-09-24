// lib/uploadGrants.js — decided before the bunny.net video exists, so every
// refusal here is one that never leaves an orphan video behind.
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_GROUPS, planUploadGrants } from "../uploadGrants";

const group = (id, videoIds = []) => ({ id, name: id.toUpperCase(), videoIds });
const map = { team: group("team"), youth: group("youth"), full: group("full", ["a", "b"]) };

describe("planUploadGrants", () => {
  it("grants nothing when nothing was ticked — an ordinary upload is unchanged", () => {
    expect(planUploadGrants(undefined, map)).toEqual({ ok: true, groupIds: [] });
    expect(planUploadGrants(null, map)).toEqual({ ok: true, groupIds: [] });
    expect(planUploadGrants([], map)).toEqual({ ok: true, groupIds: [] });
  });

  it("keeps the ticked groups, trimmed and de-duplicated", () => {
    expect(planUploadGrants(["team", " youth ", "team"], map)).toEqual({
      ok: true,
      groupIds: ["team", "youth"],
    });
  });

  it("refuses anything that is not a list of strings", () => {
    expect(planUploadGrants("team", map)).toMatchObject({ ok: false, status: 400 });
    expect(planUploadGrants([1], map)).toMatchObject({ ok: false, status: 400 });
  });

  it("REFUSES a group that no longer exists rather than skipping it", () => {
    const plan = planUploadGrants(["team", "deleted"], map);
    expect(plan).toMatchObject({ ok: false, status: 400 });
    expect(plan.error).toMatch(/no longer exist/);
  });

  // saveGroup keeps only the first N ids, so appending to a full group would
  // store nothing and say nothing.
  it("REFUSES a group already at its video cap, naming it", () => {
    const plan = planUploadGrants(["team", "full"], map, { maxVideosPerGroup: 2 });
    expect(plan).toMatchObject({ ok: false, status: 409 });
    expect(plan.error).toContain("FULL");
    expect(planUploadGrants(["team"], map, { maxVideosPerGroup: 2 })).toMatchObject({ ok: true });
  });

  it("caps how many groups one upload can name", () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_UPLOAD_GROUPS + 1 }, (_, i) => [`g${i}`, group(`g${i}`)])
    );
    expect(planUploadGrants(Object.keys(many), many)).toMatchObject({ ok: false, status: 400 });
  });
});
