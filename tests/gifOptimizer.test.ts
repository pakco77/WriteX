import assert from "node:assert/strict";
import test from "node:test";
import { gifOptimizationProfiles, gifVideoFilter } from "../src/gifOptimizer.ts";

test("GIF optimization profiles preserve animation while reducing fps, resolution, and palette", () => {
  const profiles = gifOptimizationProfiles({ width: 5120, frameRate: 50 }, 5 * 1024 * 1024);
  assert.equal(profiles[0]?.fps, 15);
  assert.ok((profiles[0]?.width ?? 9999) <= 960);
  assert.ok(profiles.at(-1)!.fps <= profiles[0]!.fps);
  assert.ok(profiles.at(-1)!.colors < profiles[0]!.colors);
  const filter = gifVideoFilter(profiles[0]!);
  assert.match(filter, /fps=15/);
  assert.match(filter, /palettegen/);
  assert.match(filter, /paletteuse/);
  assert.doesNotMatch(filter, /select=eq\(n\\,0\)/);
});
