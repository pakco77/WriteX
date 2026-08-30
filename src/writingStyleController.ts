import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CursorPosition, WritingStyleProfile, WritingStyleSourceRef } from "./types";

export interface StyleSourceInput { kind: "note" | "selection"; filePath?: string; content: string; }
export interface AllocatedStyleSource extends WritingStyleSourceRef { content: string; }

export function allocateWritingStyleSources(
  sources: StyleSourceInput[],
  maxContextChars: number,
  now: () => number = Date.now,
  hash: (value: string) => string,
): AllocatedStyleSource[] {
  let remaining = Math.max(0, maxContextChars);
  return sources.map(source => {
    const includedChars = Math.min(source.content.length, remaining);
    remaining -= includedChars;
    return {
      kind: source.kind,
      ...(source.filePath ? { filePath: source.filePath } : {}),
      sourceHash: hash(source.content),
      capturedAt: now(),
      characterCount: source.content.length,
      includedChars,
      content: source.content.slice(0, includedChars),
    };
  });
}

export interface StyleFileIdentity { owner: string; version: string; }
export interface StyleLinkResult { linked: boolean; error?: unknown; }
export interface StyleUpdateResult {
  exists: boolean;
  updated: boolean;
  backup?: StyleFileIdentity;
  target?: StyleFileIdentity;
  error?: unknown;
}

export interface StyleSkillFileAdapter {
  identity(path: string): Promise<StyleFileIdentity | undefined>;
  prepareRecoveryDirectory(path: string): Promise<void>;
  prepareTargetParent(path: string): Promise<void>;
  /** The returned owner must be read from the same exclusive file handle. */
  writeExclusive(path: string, content: string): Promise<StyleFileIdentity>;
  linkNoReplace(from: string, to: string): Promise<StyleLinkResult>;
  /** Opens and updates an existing target through one verified file handle. */
  updateExisting(input: {
    path: string;
    backupPath: string;
    content: string;
    previousExportHash?: string;
    hash: (value: string) => string;
  }): Promise<StyleUpdateResult>;
}

export async function exportStyleSkillTransaction(input: {
  adapter: StyleSkillFileAdapter;
  path: string;
  tempPath: string;
  backupPath: string;
  recoveryDirectory: string;
  content: string;
  previousExportHash?: string;
  hash?: (value: string) => string;
  persist: () => Promise<void>;
}): Promise<void> {
  const hash = input.hash ?? (() => "");
  const state: ExportState = { targetInstalled: false };
  await input.adapter.prepareRecoveryDirectory(input.recoveryDirectory);
  try {
    state.stage = await input.adapter.writeExclusive(input.tempPath, input.content);
    if (!sameIdentity(await input.adapter.identity(input.tempPath), state.stage)) {
      throw new Error("本地 Skill 临时文件校验失败，已保留恢复文件。");
    }
  } catch (error) { throw recoveryError(error, input, state); }

  if (!await verifyStage(input, state)) {
    throw recoveryError(new Error("本地 Skill 临时文件在安装前已变化，未替换原文件。"), input, state);
  }
  const update = await input.adapter.updateExisting({
    path: input.path,
    backupPath: input.backupPath,
    content: input.content,
    previousExportHash: input.previousExportHash,
    hash,
  });
  state.backup = update.backup;
  if (update.exists) {
    if (!update.updated || !update.target) throw recoveryError(moveError("本地 Skill 更新失败", update.error), input, state);
    state.target = update.target;
    state.targetInstalled = true;
  } else {
    await input.adapter.prepareTargetParent(input.path);
    if (await input.adapter.identity(input.path)) throw recoveryError(new Error("目标 Skill 已被外部文件占用，WriteX 未覆盖。"), input, state);
    const installed = await input.adapter.linkNoReplace(input.tempPath, input.path);
    if (!installed.linked) throw recoveryError(moveError("本地 Skill 安装失败", installed.error), input, state);
    const target = await input.adapter.identity(input.path);
    if (!target || !state.stage || !sameOwner(target, state.stage)) {
      throw recoveryError(new Error("本地 Skill 安装所有权校验失败，已保留恢复文件。"), input, state);
    }
    state.target = target;
    state.targetInstalled = true;
  }
  try { await input.persist(); }
  catch (error) { throw recoveryError(new Error(`${errorMessage(error)}；本地档案未保存，请核对目标 Skill 与恢复文件。`), input, state); }
}

interface ExportState {
  stage?: StyleFileIdentity;
  backup?: StyleFileIdentity;
  target?: StyleFileIdentity;
  targetInstalled: boolean;
}

function sameOwner(left: StyleFileIdentity | undefined, right: StyleFileIdentity | undefined): boolean {
  if (!left || !right) return left === right;
  return left.owner === right.owner;
}

function sameIdentity(left: StyleFileIdentity | undefined, right: StyleFileIdentity | undefined): boolean {
  if (!left || !right) return left === right;
  return left.owner === right.owner && left.version === right.version;
}

function moveError(prefix: string, error: unknown): Error {
  return new Error(error ? `${prefix}：${errorMessage(error)}` : prefix);
}

async function verifyStage(input: { adapter: StyleSkillFileAdapter; tempPath: string; content: string }, state: ExportState): Promise<boolean> {
  return sameIdentity(await input.adapter.identity(input.tempPath), state.stage);
}

function recoveryError(
  original: unknown,
  input: { tempPath: string; backupPath: string; recoveryDirectory: string },
  state: ExportState,
): Error {
  const paths = [state.stage ? input.tempPath : "", state.backup ? input.backupPath : ""].filter(Boolean);
  return new Error(`${errorMessage(original)}；恢复目录：${input.recoveryDirectory}${paths.length ? `；保留文件：${paths.join("、")}` : ""}`);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function withIsolatedStyleExtractionCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "writex-style-"));
  await chmod(cwd, 0o700);
  try { return await run(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

export async function routeTopicToChat(input: {
  hasDraft: () => boolean;
  openTarget: () => Promise<void>;
  activateChat: () => Promise<{ prepare: () => boolean } | null>;
}): Promise<boolean> {
  if (input.hasDraft()) return false;
  await input.openTarget();
  const chat = await input.activateChat();
  if (!chat) throw new Error("无法打开 WriteX Chat。");
  return chat.prepare();
}

export async function persistWritingStyleProfile(input: {
  state: { writingStyleProfile?: WritingStyleProfile };
  profile: WritingStyleProfile;
  persist: () => Promise<void>;
  refreshViews: () => void;
}): Promise<void> {
  const previous = input.state.writingStyleProfile;
  input.state.writingStyleProfile = input.profile;
  try {
    await input.persist();
    input.refreshViews();
  } catch (error) {
    input.state.writingStyleProfile = previous;
    throw error;
  }
}

export function replaceCapturedRange(
  editor: { getRange(from: CursorPosition, to: CursorPosition): string; replaceRange(value: string, from: CursorPosition, to: CursorPosition): void; focus(): void },
  context: { text: string; from: CursorPosition; to: CursorPosition },
  replacement: string,
): void {
  if (editor.getRange(context.from, context.to) !== context.text) throw new Error("原选区已经变化，请重新划词后再替换。");
  editor.replaceRange(replacement, context.from, context.to);
  try { editor.focus(); }
  catch { /* The editor write has committed; focus restoration must not make it retryable. */ }
}
