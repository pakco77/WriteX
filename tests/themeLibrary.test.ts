import assert from "node:assert/strict";
import test from "node:test";
import { filterThemeRows, themeActions, type ThemeLibraryRow } from "../src/themeLibrary.ts";

function row(overrides: Partial<ThemeLibraryRow> = {}): ThemeLibraryRow {
  return {
    id: "moyu-green",
    name: "摸鱼绿",
    version: "1.0.0",
    author: "Jia Gu",
    license: "AGPL-3.0",
    sourceUrl: "https://github.com/isjiamu/gzh-design-skill",
    status: "available",
    sourceType: undefined,
    ...overrides,
  };
}

test("theme library search covers name author license and source, case-insensitively", () => {
  const items = [
    row(),
    row({ id: "xiaohei", name: "小黑", author: "Pakco", license: "MIT", sourceUrl: "local://builtin", status: "builtin", sourceType: "builtin" }),
  ];
  assert.deepEqual(filterThemeRows(items, "jia gu", "all").map(item => item.id), ["moyu-green"]);
  assert.deepEqual(filterThemeRows(items, "agpl", "all").map(item => item.id), ["moyu-green"]);
  assert.deepEqual(filterThemeRows(items, "GZH-DESIGN", "all").map(item => item.id), ["moyu-green"]);
  assert.deepEqual(filterThemeRows(items, "小黑", "all").map(item => item.id), ["xiaohei"]);
});

test("theme library status filters separate installed available update and failed", () => {
  const items = [
    row({ id: "builtin", status: "builtin", sourceType: "builtin" }),
    row({ id: "installed", status: "installed", sourceType: "download" }),
    row({ id: "available", status: "available" }),
    row({ id: "update", status: "update", sourceType: "download" }),
    row({ id: "failed", status: "failed" }),
    row({ id: "waiting", status: "waiting" }),
  ];
  assert.deepEqual(filterThemeRows(items, "", "installed").map(item => item.id), ["builtin", "installed"]);
  assert.deepEqual(filterThemeRows(items, "", "available").map(item => item.id), ["available"]);
  assert.deepEqual(filterThemeRows(items, "", "update").map(item => item.id), ["update"]);
  assert.deepEqual(filterThemeRows(items, "", "failed").map(item => item.id), ["failed", "waiting"]);
});

test("theme actions respect built-in downloaded custom and current-theme boundaries", () => {
  assert.deepEqual(themeActions(row({ id: "default", status: "builtin", sourceType: "builtin" }), "default"), ["export", "duplicate"]);
  assert.deepEqual(themeActions(row({ id: "remote", status: "installed", sourceType: "download" }), "remote"), ["export", "duplicate"]);
  assert.deepEqual(themeActions(row({ id: "remote", status: "installed", sourceType: "download" }), "default"), ["select", "export", "duplicate"]);
  assert.deepEqual(themeActions(row({ id: "custom", status: "installed", sourceType: "import" }), "default"), ["select", "export", "duplicate", "rename", "delete"]);
  assert.deepEqual(themeActions(row({ id: "compiled", status: "installed", sourceType: "compiled" }), "compiled"), ["export", "duplicate", "rename"]);
  assert.deepEqual(themeActions(row({ id: "new", status: "available" }), "default"), ["install"]);
  assert.deepEqual(themeActions(row({ id: "broken", status: "failed" }), "default"), ["retry"]);
  assert.deepEqual(themeActions(row({ id: "busy", status: "installing" }), "default"), ["cancel"]);
});
