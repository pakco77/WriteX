import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_THEMES } from "../src/themeBuiltins.ts";
import { validateThemePackage } from "../src/themeSchema.ts";

test("Default and Xiaohei are built-in packages validated by the public schema", () => {
  assert.equal(BUILTIN_THEMES.default.manifest.license, "MIT");
  assert.equal(BUILTIN_THEMES.xiaohei.manifest.id, "xiaohei");
  assert.equal(validateThemePackage(BUILTIN_THEMES.default).ok, true);
  assert.equal(validateThemePackage(BUILTIN_THEMES.xiaohei).ok, true);
});

test("Xiaohei follows the approved authority overrides without injected content", () => {
  const xiaohei = JSON.stringify(BUILTIN_THEMES.xiaohei);
  assert.match(xiaohei, /6109e161cb7973984cad697474393044305da8a576a0cab3186126f797f8263c/);
  assert.match(xiaohei, /font-size:15px/);
  assert.match(xiaohei, /line-height:1\.75/);
  assert.match(xiaohei, /margin:8px 12px 16px/);
  assert.match(xiaohei, /rgb\(89, 89, 89\)/);
  assert.match(xiaohei, /rgb\(25, 26, 36\)/);
  assert.doesNotMatch(xiaohei, /font-style:italic/);
  assert.doesNotMatch(xiaohei, /感谢关注|作者：pakco|购买猫粮/);
});
