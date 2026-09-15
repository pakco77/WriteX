import assert from "node:assert/strict";
import test from "node:test";
import { applyCompactTheme } from "../src/compactLayout.ts";

test("a failed compact-layout persistence restores the original theme for a retry", async () => {
  const state: { themeId?: string } = { themeId: "moyu" };
  await assert.rejects(applyCompactTheme({ state, persist: async () => { throw new Error("disk full"); } }), /disk full/);
  assert.equal(state.themeId, "moyu");
});
