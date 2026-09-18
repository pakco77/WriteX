import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { WriteXThemePackage } from "../src/themeSchema.ts";
import {
  renderThemeUsageGuide,
  THEME_USAGE_GUIDE_SPECS,
} from "../src/themeUsageGuide.ts";

const PACKS_ROOT = new URL("../../../10_Source/writex-theme-packs/themes", import.meta.url).pathname;
const PACKS_AVAILABLE = existsSync(`${PACKS_ROOT}/moyu-green.writex-theme.json`);

async function readPack(id: string): Promise<WriteXThemePackage> {
  return JSON.parse(await readFile(`${PACKS_ROOT}/${id}.writex-theme.json`, "utf8")) as WriteXThemePackage;
}

test("every guide spec has a distinct id, label, and non-empty syntax", () => {
  const ids = THEME_USAGE_GUIDE_SPECS.map(spec => spec.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const spec of THEME_USAGE_GUIDE_SPECS) {
    assert.ok(spec.label.trim(), `${spec.id} needs a label`);
    assert.ok(spec.syntax.trim(), `${spec.id} needs syntax`);
    assert.ok(spec.markdown.trim(), `${spec.id} needs markdown`);
  }
});

test("the usage guide renders a real demo for every entry with moyu-green", { skip: !PACKS_AVAILABLE }, async () => {
  const theme = await readPack("moyu-green");
  const guide = renderThemeUsageGuide(theme);

  assert.equal(guide.length, THEME_USAGE_GUIDE_SPECS.length);
  for (const entry of guide) {
    assert.ok(entry.html.length > 0, `${entry.id} rendered an empty demo`);
    assert.ok(!entry.html.includes("undefined"), `${entry.id} demo contains undefined`);
  }
  const summary = guide.find(entry => entry.id === "article-summary");
  assert.ok(summary?.html.includes("一句摘要写在最前"), "summary entry renders the summary text");
  const title = guide.find(entry => entry.id === "article-title");
  assert.ok(title?.html.includes("文章标题"), "title entry renders the heading text");
});

test("guide demos differ across themes while syntax stays identical", { skip: !PACKS_AVAILABLE }, async () => {
  const green = await readPack("moyu-green");
  const red = await readPack("red-white");
  const greenGuide = renderThemeUsageGuide(green);
  const redGuide = renderThemeUsageGuide(red);

  assert.deepEqual(
    greenGuide.map(entry => entry.syntax),
    redGuide.map(entry => entry.syntax),
  );
  const headingDemoGreen = greenGuide.find(entry => entry.id === "heading2")?.html ?? "";
  const headingDemoRed = redGuide.find(entry => entry.id === "heading2")?.html ?? "";
  assert.notEqual(headingDemoGreen, headingDemoRed);
});

test("a broken theme degrades to empty demos instead of throwing", { skip: !PACKS_AVAILABLE }, async () => {
  const theme = await readPack("moyu-green");
  const broken = {
    ...theme,
    components: { paragraph: { template: "<p>{{children}}</p>" } },
  } as unknown as WriteXThemePackage;
  const guide = renderThemeUsageGuide(broken);
  assert.equal(guide.length, THEME_USAGE_GUIDE_SPECS.length);
  assert.ok(guide.every(entry => entry.html === ""));
});
