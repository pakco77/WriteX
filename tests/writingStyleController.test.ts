import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  allocateWritingStyleSources,
  exportStyleSkillTransaction,
  routeTopicToChat,
  replaceCapturedRange,
  persistWritingStyleProfile,
  withIsolatedStyleExtractionCwd,
} from "../src/writingStyleController.ts";
import { runAndRecordAssistant } from "../src/chatTurnController.ts";
import { access, link, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("style source allocation is deterministic and reports partial and full truncation before the Agent turn", () => {
  const result = allocateWritingStyleSources([
    { kind: "note", filePath: "a.md", content: "甲".repeat(4) },
    { kind: "note", filePath: "b.md", content: "乙".repeat(4) },
    { kind: "selection", content: "丙".repeat(2) },
  ], 6, () => 10, value => `hash:${value}`);
  assert.deepEqual(result.map(source => [source.filePath, source.includedChars, source.characterCount, source.content]), [
    ["a.md", 4, 4, "甲".repeat(4)], ["b.md", 2, 4, "乙".repeat(2)], [undefined, 0, 2, ""],
  ]);
});

function nodeIdentity(path: string): Promise<{ owner: string; version: string } | undefined> {
  return stat(path, { bigint: true }).then(file => ({ owner: `${file.dev}:${file.ino}`, version: `${file.ctimeNs}:${file.size}` }))
    .catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error));
}

const nodeAdapter = {
  identity: nodeIdentity,
  prepareRecoveryDirectory: async (path: string) => { await mkdir(path, { mode: 0o700 }); },
  prepareTargetParent: async (path: string) => { await mkdir(join(path, ".."), { recursive: true }); },
  writeExclusive: async (path: string, content: string) => {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(content, "utf8"); await file.sync(); const written = await file.stat({ bigint: true }); return { owner: `${written.dev}:${written.ino}`, version: `${written.ctimeNs}:${written.size}` }; }
    finally { await file.close(); }
  },
  linkNoReplace: async (from: string, to: string) => {
    try { await link(from, to); return { linked: true }; }
    catch (error) { return { linked: false, error }; }
  },
  updateExisting: async ({ path, backupPath, content, previousExportHash, hash }: { path: string; backupPath: string; content: string; previousExportHash?: string; hash: (value: string) => string }) => {
    let file;
    try { file = await open(path, "r+"); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { exists: false, updated: false } : { exists: true, updated: false, error }; }
    let backup: { owner: string; version: string } | undefined;
    try {
      const beforeStat = await file.stat({ bigint: true });
      const before = Buffer.from(await file.readFile()).toString("utf8");
      const owner = `${beforeStat.dev}:${beforeStat.ino}`;
      const version = `${beforeStat.ctimeNs}:${beforeStat.size}`;
      const current = await nodeIdentity(path);
      if (!current || current.owner !== owner || current.version !== version || !previousExportHash || hash(before) !== previousExportHash) {
        return { exists: true, updated: false, error: new Error("manual change") };
      }
      const recovery = await open(backupPath, "wx", 0o600);
      try { await recovery.writeFile(before, "utf8"); await recovery.sync(); const saved = await recovery.stat({ bigint: true }); backup = { owner: `${saved.dev}:${saved.ino}`, version: `${saved.ctimeNs}:${saved.size}` }; }
      finally { await recovery.close(); }
      const beforeWrite = await file.stat({ bigint: true });
      const currentBeforeWrite = await nodeIdentity(path);
      if (!currentBeforeWrite || currentBeforeWrite.owner !== owner || currentBeforeWrite.version !== version || `${beforeWrite.dev}:${beforeWrite.ino}` !== owner || `${beforeWrite.ctimeNs}:${beforeWrite.size}` !== version) {
        return { exists: true, updated: false, backup, error: new Error("changed before write") };
      }
      const bytes = Buffer.from(content, "utf8");
      await file.truncate(0); await file.write(bytes, 0, bytes.length, 0); await file.truncate(bytes.length); await file.sync();
      const target = await nodeIdentity(path);
      if (!target || target.owner !== owner || await readFile(path, "utf8") !== content) return { exists: true, updated: false, backup, error: new Error("external replacement") };
      return { exists: true, updated: true, backup, target };
    } catch (error) { return { exists: true, updated: false, backup, error }; }
    finally { await file.close(); }
  },
};

function exportInput(root: string, content: string, previousExportHash?: string, path = join(root, "SKILL.md")) {
  const recoveryDirectory = join(root, ".writex-recovery", randomUUID());
  return {
    path, recoveryDirectory,
    tempPath: join(recoveryDirectory, "candidate.SKILL.md"), backupPath: join(recoveryDirectory, "previous.SKILL.md"),
    content, previousExportHash, hash: (value: string) => value, persist: async () => undefined,
  };
}

test("real exclusive export creates a nested first target and retains recovery artifacts", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-style-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".writex-recovery"));
  const first = exportInput(root, "new", undefined, join(root, ".agents", "skills", "writex-my-style", "SKILL.md"));
  await exportStyleSkillTransaction({ ...first, adapter: nodeAdapter });
  assert.equal(await readFile(first.path, "utf8"), "new");
  assert.equal(await readFile(first.tempPath, "utf8"), "new");
  await assert.rejects(access(first.backupPath));

  const target = join(root, "SKILL.md");
  await writeFile(target, "old", "utf8");
  const update = exportInput(root, "new", "old");
  await exportStyleSkillTransaction({ ...update, adapter: nodeAdapter });
  assert.equal(await readFile(update.path, "utf8"), "new");
  assert.equal(await readFile(update.tempPath, "utf8"), "new");
  assert.equal(await readFile(update.backupPath, "utf8"), "old");

  await writeFile(update.path, "old", "utf8");
  const failed = exportInput(root, "new", "old");
  await assert.rejects(exportStyleSkillTransaction({ ...failed, adapter: nodeAdapter, persist: async () => { throw new Error("persist failed"); } }), /persist failed.*恢复目录/s);
  assert.equal(await readFile(failed.path, "utf8"), "new");
  assert.equal(await readFile(failed.tempPath, "utf8"), "new");
  assert.equal(await readFile(failed.backupPath, "utf8"), "old");
});

test("real recovery path guards preserve external target and stage", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-style-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".writex-recovery"));
  const targetRace = exportInput(root, "new");
  await writeFile(targetRace.path, "old", "utf8");
  await assert.rejects(exportStyleSkillTransaction({ ...targetRace, adapter: {
    ...nodeAdapter,
    updateExisting: async input => {
      const external = `${input.path}.external`;
      await writeFile(external, "new", "utf8"); await rename(external, input.path);
      return nodeAdapter.updateExisting(input);
    },
  }, previousExportHash: "old" }), /更新失败/);
  assert.equal(await readFile(targetRace.path, "utf8"), "new");
  assert.equal(await readFile(targetRace.tempPath, "utf8"), "new");

  const stageRace = exportInput(root, "new");
  await assert.rejects(exportStyleSkillTransaction({ ...stageRace, adapter: {
    ...nodeAdapter,
    writeExclusive: async (path, content) => {
      const written = await nodeAdapter.writeExclusive(path, content);
      const external = `${path}.external`; await writeFile(external, "new", "utf8"); await rename(external, path);
      return written;
    },
  } }), /临时文件校验失败/);
  assert.equal(await readFile(stageRace.tempPath, "utf8"), "new");
});

test("topic routing always opens the Markdown target and Chat, while preserving a target draft", async () => {
  const events: string[] = [];
  assert.equal(await routeTopicToChat({ hasDraft: () => true, openTarget: async () => events.push("target"), activateChat: async () => { events.push("chat"); return { prepare: () => { events.push("prepare"); return true; } }; } }), false);
  assert.deepEqual(events, ["target", "chat"]);
  assert.equal(await routeTopicToChat({ hasDraft: () => false, openTarget: async () => events.push("target"), activateChat: async () => { events.push("chat"); return { prepare: () => { events.push("prepare"); return true; } }; } }), true);
  assert.deepEqual(events, ["target", "chat", "target", "chat", "prepare"]);
});

test("selection replacement always checks its captured range even when another selection has identical text", () => {
  const calls: Array<[string, unknown?, unknown?]> = [];
  const editor = {
    getRange: () => "同一句",
    replaceRange: (value: string, from: unknown, to: unknown) => calls.push([value, from, to]),
    focus: () => calls.push(["focus"]),
  };
  replaceCapturedRange(editor, { text: "同一句", from: { line: 0, ch: 0 }, to: { line: 0, ch: 3 } }, "新句");
  assert.deepEqual(calls, [["新句", { line: 0, ch: 0 }, { line: 0, ch: 3 }], ["focus"]]);
  assert.throws(() => replaceCapturedRange({ ...editor, getRange: () => "已经变了" }, { text: "同一句", from: { line: 0, ch: 0 }, to: { line: 0, ch: 3 } }, "新句"), /原选区已经变化/);
});

test("a committed replacement is not retried when focus restoration fails", async () => {
  let replacements = 0;
  const controller = new (await import("../src/selectionCompareController.ts")).SelectionCompareController(async () => {
    replaceCapturedRange({
      getRange: () => "原文",
      replaceRange: () => { replacements += 1; },
      focus: () => { throw new Error("focus failed"); },
  }, { text: "原文", from: { line: 0, ch: 0 }, to: { line: 0, ch: 2 } }, "原文");
  }, () => undefined);
  assert.equal(await controller.applyOnce(), true);
  assert.equal(await controller.applyOnce(), false);
  assert.equal(replacements, 1);
});

test("confirmed profile refreshes every open Chat view only after persistence succeeds", async () => {
  const profile = { markdown: "风格", sources: [], revision: 1, agent: "codex" as const, model: "默认", createdAt: 1, updatedAt: 1 };
  const state: { writingStyleProfile?: typeof profile } = {};
  let refreshes = 0;
  await persistWritingStyleProfile({ state, profile, persist: async () => undefined, refreshViews: () => { refreshes += 2; } });
  assert.equal(state.writingStyleProfile, profile);
  assert.equal(refreshes, 2);
  await assert.rejects(persistWritingStyleProfile({ state, profile: { ...profile, revision: 2 }, persist: async () => { throw new Error("save failed"); }, refreshViews: () => { refreshes += 10; } }), /save failed/);
  assert.equal(state.writingStyleProfile, profile);
  assert.equal(refreshes, 2);
});

test("style extraction runs from a removable private temporary cwd, never a representative-work directory", async () => {
  let isolated = "";
  await withIsolatedStyleExtractionCwd(async cwd => {
    isolated = cwd;
    assert.match(cwd, /writex-style-/);
    await assert.rejects(access(`${cwd}/not-a-vault-note.md`));
  });
  await assert.rejects(access(isolated));
});

test("failed Agent turns never record a writing-style snapshot; only a returned assistant result can do so", async () => {
  const messages: Array<{ writingStyle?: { revision: number } }> = [];
  await assert.rejects(runAndRecordAssistant(async () => { throw new Error("Agent failed"); }, () => messages.push({ writingStyle: { revision: 1 } })), /Agent failed/);
  assert.deepEqual(messages, []);
  await runAndRecordAssistant(async () => "answer", () => messages.push({ writingStyle: { revision: 1 } }));
  assert.deepEqual(messages, [{ writingStyle: { revision: 1 } }]);
});
