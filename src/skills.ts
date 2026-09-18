import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { accessSync, realpathSync } from "node:fs";
import { access, lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface LocalSkill {
  id: string;
  name: string;
  description: string;
  directory: string;
  skillFile: string;
  rootLabel: string;
  source: string;
  sourceHash: string;
  scope: "current" | "vault";
  aliases: string[];
}

export type SkillPathStatus =
  | { kind: "valid" }
  | { kind: "invalid"; reason: string }
  | { kind: "missing" };

const MAX_SKILL_FILE_BYTES = 128 * 1024;

const SKILL_ROOTS = [
  ["Agent", ".agents/skills"],
  ["Codex", ".codex/skills"],
  ["Claude", ".claude/skills"],
] as const;

function frontmatterValue(source: string, key: string): string {
  const block = source.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1] ?? "";
  const lines = block.split("\n");
  const index = lines.findIndex(line => new RegExp(`^${key}:\\s*`).test(line));
  if (index < 0) return "";
  let value = lines[index]!.replace(new RegExp(`^${key}:\\s*`), "").trim();
  if (/^[>|][+-]?$/.test(value)) {
    const folded: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (line.trim() && !/^\s/.test(line)) break;
      if (line.trim()) folded.push(line.trim());
    }
    value = folded.join(" ");
  }
  return value.replace(/^(["'])(.*)\1$/, "$2").trim();
}

type ReadSkillFile = (path: string) => Promise<string>;

interface ParsedSkill {
  name: string;
  description: string;
  source: string;
  sourceHash: string;
}

interface SkillOccurrence {
  skillFile: string;
  ownerDirectory: string;
  agentLabel: typeof SKILL_ROOTS[number][0];
  agentRank: number;
}

interface IndexedSkill extends ParsedSkill {
  realSkillFile: string;
  occurrences: SkillOccurrence[];
}

interface CachedSkillFile {
  size: number;
  mtimeMs: number;
  parsed: ParsedSkill | null;
  invalidReason: string;
}

interface SkillScan {
  indexedSkills: IndexedSkill[];
  fileCache: Map<string, CachedSkillFile>;
  invalidSkillPaths: Map<string, string>;
}

interface InvalidIndexedSkill {
  reason: string;
  paths: Set<string>;
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function isMissingFilesystemEntry(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function parseSkillSource(source: string): { parsed: ParsedSkill | null; invalidReason: string } {
  if (!source.trim()) return { parsed: null, invalidReason: "SKILL.md 内容为空。" };
  if (Buffer.byteLength(source, "utf8") > MAX_SKILL_FILE_BYTES) {
    return { parsed: null, invalidReason: "SKILL.md 超过 128 KiB 上限。" };
  }
  const name = frontmatterValue(source, "name");
  const description = frontmatterValue(source, "description");
  if (!name && !description) return { parsed: null, invalidReason: "SKILL.md 缺少 name 和 description。" };
  if (!name) return { parsed: null, invalidReason: "SKILL.md 缺少 name。" };
  if (!description) return { parsed: null, invalidReason: "SKILL.md 缺少 description。" };
  return {
    parsed: {
      name,
      description,
      source,
      sourceHash: createHash("sha256").update(source).digest("hex"),
    },
    invalidReason: "",
  };
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (isMissingFilesystemEntry(error)) return false;
    throw error;
  }
}

function noteAncestors(vaultRoot: string, activeFilePath?: string): string[] {
  const root = resolve(vaultRoot);
  if (!activeFilePath) return [root];
  const note = resolve(root, activeFilePath);
  const relativeNote = relative(root, note);
  if (isAbsolute(relativeNote) || relativeNote === ".." || relativeNote.startsWith(`..${sep}`)) return [root];
  const ancestors: string[] = [];
  let cursor = dirname(note);
  while (true) {
    ancestors.push(cursor);
    if (cursor === root) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return ancestors;
}

async function vaultDirectories(vaultRoot: string): Promise<string[]> {
  const directories = [resolve(vaultRoot)];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFilesystemEntry(error)) continue;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      directories.push(join(directory, entry.name));
    }
  }
  return directories;
}

async function scanVaultSkills(
  vaultRoot: string,
  readSkillFile: ReadSkillFile,
  previousCache: Map<string, CachedSkillFile>,
): Promise<SkillScan> {
  const skills = new Map<string, IndexedSkill>();
  const invalid = new Map<string, InvalidIndexedSkill>();
  const fileCache = new Map<string, CachedSkillFile>();
  const realVaultRoot = await realpath(resolve(vaultRoot));
  for (const ownerDirectory of await vaultDirectories(vaultRoot)) {
    for (const [agentRank, [agentLabel, relativeRoot]] of SKILL_ROOTS.entries()) {
      const root = resolve(ownerDirectory, relativeRoot);
      const marker = dirname(root);
      if (!await isRealDirectory(marker) || !await isRealDirectory(root)) continue;
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if (isMissingFilesystemEntry(error)) continue;
        throw error;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const directory = join(root, entry.name);
        const skillFile = join(directory, "SKILL.md");
        try {
          const realSkillFile = await realpath(skillFile);
          if (!isInside(realVaultRoot, realSkillFile)) continue;
          let skill = skills.get(realSkillFile);
          let invalidSkill = invalid.get(realSkillFile);
          if (!skill && !invalidSkill) {
            const metadata = await stat(realSkillFile);
            const cached = previousCache.get(realSkillFile);
            const cacheHit = cached?.size === metadata.size && cached.mtimeMs === metadata.mtimeMs;
            let parsed = cacheHit ? cached.parsed : undefined;
            let invalidReason = cacheHit ? cached.invalidReason : "";
            if (parsed === undefined && (!metadata.isFile() || metadata.size > MAX_SKILL_FILE_BYTES)) {
              parsed = null;
              invalidReason = metadata.isFile()
                ? "SKILL.md 超过 128 KiB 上限。"
                : "SKILL.md 不是普通文件。";
            } else if (parsed === undefined) {
              const source = await readSkillFile(realSkillFile);
              ({ parsed, invalidReason } = parseSkillSource(source));
            }
            fileCache.set(realSkillFile, { size: metadata.size, mtimeMs: metadata.mtimeMs, parsed, invalidReason });
            if (!parsed) {
              invalidSkill = { reason: invalidReason || "SKILL.md 格式无效。", paths: new Set([realSkillFile]) };
              invalid.set(realSkillFile, invalidSkill);
            } else {
              skill = {
                realSkillFile,
                ...parsed,
                occurrences: [],
              };
              skills.set(realSkillFile, skill);
            }
          }
          if (invalidSkill) {
            invalidSkill.paths.add(skillFile);
            continue;
          }
          if (skill && !skill.occurrences.some(occurrence => occurrence.skillFile === skillFile)) {
            skill.occurrences.push({ skillFile, ownerDirectory, agentLabel, agentRank });
          }
        } catch (error) {
          if (!isMissingFilesystemEntry(error)) throw error;
          // The candidate was removed while the complete Vault index was being built.
        }
      }
    }
  }
  const invalidSkillPaths = new Map<string, string>();
  for (const candidate of invalid.values()) {
    for (const path of candidate.paths) invalidSkillPaths.set(path, candidate.reason);
  }
  return { indexedSkills: [...skills.values()], fileCache, invalidSkillPaths };
}

function occurrenceSource(vaultRoot: string, occurrence: SkillOccurrence): string {
  const owner = relative(resolve(vaultRoot), occurrence.ownerDirectory) || "Vault 根目录";
  return `${owner}\0${occurrence.agentRank}\0${occurrence.skillFile}`;
}

function localSkills(indexedSkills: IndexedSkill[], vaultRoot: string, activeFilePath?: string): LocalSkill[] {
  const ancestors = noteAncestors(vaultRoot, activeFilePath);
  const ranked = indexedSkills.map(indexed => {
    const current = indexed.occurrences
      .map(occurrence => ({ occurrence, distance: ancestors.indexOf(occurrence.ownerDirectory) }))
      .filter(candidate => candidate.distance >= 0)
      .sort((a, b) => a.distance - b.distance
        || occurrenceSource(vaultRoot, a.occurrence).localeCompare(occurrenceSource(vaultRoot, b.occurrence)))[0];
    const occurrence = current?.occurrence ?? [...indexed.occurrences]
      .sort((a, b) => occurrenceSource(vaultRoot, a).localeCompare(occurrenceSource(vaultRoot, b)))[0]!;
    const scope = current ? "current" as const : "vault" as const;
    const owner = relative(resolve(vaultRoot), occurrence.ownerDirectory) || "Vault 根目录";
    return {
      distance: current?.distance ?? Number.POSITIVE_INFINITY,
      source: occurrenceSource(vaultRoot, occurrence),
      skill: {
        id: indexed.realSkillFile,
        name: indexed.name,
        description: indexed.description,
        directory: dirname(indexed.realSkillFile),
        skillFile: indexed.realSkillFile,
        rootLabel: `${scope === "current" ? "当前项目" : "Vault 其他项目"} · ${owner} · ${occurrence.agentLabel}`,
        source: indexed.source,
        sourceHash: indexed.sourceHash,
        scope,
        aliases: [...new Set(indexed.occurrences.map(item => item.skillFile).filter(path => path !== indexed.realSkillFile))].sort(),
      },
    };
  });
  return ranked.sort((a, b) => {
    if (a.skill.scope !== b.skill.scope) return a.skill.scope === "current" ? -1 : 1;
    if (a.skill.scope === "current" && a.distance !== b.distance) return a.distance - b.distance;
    return a.skill.name.localeCompare(b.skill.name)
      || a.source.localeCompare(b.source)
      || a.skill.skillFile.localeCompare(b.skill.skillFile);
  }).map(item => item.skill);
}

export class VaultSkillIndex {
  private readonly vaultRoot: string;
  private readonly readSkillFile: ReadSkillFile;
  private indexedSkills: IndexedSkill[] | null = null;
  private fileCache = new Map<string, CachedSkillFile>();
  private invalidSkillPaths = new Map<string, string>();
  private scanGeneration = 0;
  private currentScan: { generation: number; promise: Promise<void> } | null = null;
  private latestScanFailure: { generation: number; error: unknown } | null = null;

  constructor(
    vaultRoot: string,
    readSkillFile: ReadSkillFile = path => readFile(path, "utf8"),
  ) {
    this.vaultRoot = vaultRoot;
    this.readSkillFile = readSkillFile;
  }

  async discover(activeFilePath?: string, options?: { refresh?: boolean }): Promise<LocalSkill[]> {
    if (!this.indexedSkills && !options?.refresh && this.currentScan) {
      await this.followLatestScan(this.currentScan);
    } else if (!this.indexedSkills || options?.refresh) {
      await this.refreshIndex();
    }
    if (!this.indexedSkills) throw new Error("Skill 扫描已被更新请求取代，请重试。");
    return localSkills(this.indexedSkills, this.vaultRoot, activeFilePath);
  }

  invalidate(): void {
    this.scanGeneration += 1;
    this.indexedSkills = null;
    this.invalidSkillPaths.clear();
    this.currentScan = null;
    this.latestScanFailure = null;
  }

  getPathStatus(path: string): SkillPathStatus {
    const normalized = resolve(path);
    if (this.indexedSkills?.some(skill => skill.realSkillFile === normalized
      || skill.occurrences.some(occurrence => occurrence.skillFile === normalized))) {
      return { kind: "valid" };
    }
    const reason = this.invalidSkillPaths.get(normalized);
    return reason ? { kind: "invalid", reason } : { kind: "missing" };
  }

  private async refreshIndex(): Promise<void> {
    const generation = ++this.scanGeneration;
    this.latestScanFailure = null;
    const promise = (async () => {
      try {
        const scan = await scanVaultSkills(this.vaultRoot, this.readSkillFile, this.fileCache);
        if (generation === this.scanGeneration) {
          this.indexedSkills = scan.indexedSkills;
          this.fileCache = scan.fileCache;
          this.invalidSkillPaths = scan.invalidSkillPaths;
          this.latestScanFailure = null;
        }
      } catch (error) {
        if (generation === this.scanGeneration) this.latestScanFailure = { generation, error };
        throw error;
      }
    })();
    const scan = { generation, promise };
    this.currentScan = scan;
    try {
      await this.followLatestScan(scan);
    } finally {
      if (this.currentScan?.generation === generation) this.currentScan = null;
    }
  }

  private async followLatestScan(initialScan: { generation: number; promise: Promise<void> }): Promise<void> {
    let observedScan = initialScan;
    while (true) {
      try {
        await observedScan.promise;
      } catch (error) {
        const newerScan = this.currentScan;
        if (newerScan && newerScan.generation > observedScan.generation) {
          observedScan = newerScan;
          continue;
        }
        if (this.latestScanFailure?.generation === this.scanGeneration) throw this.latestScanFailure.error;
        if (this.scanGeneration > observedScan.generation && this.indexedSkills) return;
        throw error;
      }
      const newerScan = this.currentScan;
      if (newerScan && newerScan.generation > observedScan.generation) {
        observedScan = newerScan;
        continue;
      }
      if (this.latestScanFailure?.generation === this.scanGeneration) throw this.latestScanFailure.error;
      return;
    }
  }
}

export function discoverLocalSkills(vaultRoot: string, activeFilePath?: string): Promise<LocalSkill[]> {
  return new VaultSkillIndex(vaultRoot).discover(activeFilePath);
}

export function findLocalSkillByPath(skills: LocalSkill[], path: string | undefined): LocalSkill | undefined {
  if (!path) return undefined;
  return skills.find(skill => skill.skillFile === path || skill.aliases.includes(path));
}

/**
 * 安装完成后对比刷新前后的 Skill 列表：只有恰好新增一个 Skill 时才返回它，
 * 供调用方直接启用；零个或多个时不猜测，返回 undefined。
 */
export function findNewlyInstalledSkill(before: LocalSkill[], after: LocalSkill[]): LocalSkill | undefined {
  const known = new Set<string>();
  for (const skill of before) {
    known.add(skill.skillFile);
    for (const alias of skill.aliases) known.add(alias);
  }
  const added = after.filter(skill => !known.has(skill.skillFile)
    && !skill.aliases.some(alias => known.has(alias)));
  return added.length === 1 ? added[0] : undefined;
}

export function isCurrentSkillScan(
  requestId: number,
  notePath: string,
  currentRequestId: number,
  currentNotePath: string,
): boolean {
  return requestId === currentRequestId && notePath === currentNotePath;
}

export function buildExplicitSkillInstruction(skill: LocalSkill): string {
  return [
    "本轮用户显式启用了一个本地 Skill。",
    `Skill 名称：${skill.name}`,
    `Skill 文件：${skill.skillFile}`,
    `Skill SHA-256：${skill.sourceHash}`,
    "WriteX 已先完整读取该 SKILL.md，并把完整主文件放在下面；必须遵循它，不要只根据 Skill 名称猜测。",
    "<write-skill-source>",
    skill.source,
    "</write-skill-source>",
    "仅按主文件路由读取本任务确实需要的相对引用。",
    "允许为使用该 Skill 读取其目录内文件；不要修改任何文件，不要访问网络，不要运行无关命令。",
    "最终回答中简短标明已使用的 Skill 名称。",
  ].join("\n");
}

export function isSupportedSkillSource(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

export function buildSkillInstallArgs(source: string): string[] {
  if (!isSupportedSkillSource(source)) throw new Error("只支持 HTTPS GitHub Skill 地址。");
  return ["skills@latest", "add", source.trim(), "--agent", "universal", "--yes", "--copy"];
}

async function resolveNpx(): Promise<string> {
  const candidates = [
    join(homedir(), ".local", "bin", "npx"),
    "/opt/homebrew/bin/npx",
    "/usr/local/bin/npx",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next common desktop path.
    }
  }
  return "npx";
}

function directoryHasFile(directory: string, name: string): boolean {
  try {
    accessSync(join(directory, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * npx 可能是多层软链（如 ~/.local/bin/npx → …/npm/bin/npx-cli.js），node 可执行
 * 文件不一定与 npx 真实路径同目录。从 npx 真实目录向上找最近一层包含 node 的
 * 目录（兼容 node 直接位于该目录或该目录的 bin/ 子目录两种布局）。
 */
function findNodeDirectory(startDirectory: string): string | null {
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  let directory = startDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    if (directoryHasFile(directory, nodeName)) return directory;
    if (directoryHasFile(join(directory, "bin"), nodeName)) return join(directory, "bin");
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * GUI 应用（如 Obsidian）的 PATH 通常只有 /usr/bin:/bin，而 npx shim 依赖
 * `#!/usr/bin/env node` 找 node。解析 npx 真实路径后，把提供 node 的目录放到
 * PATH 最前，否则 spawn 会以 “env: node: No such file or directory” 失败。
 */
export function buildSkillInstallEnv(
  binary: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, DO_NOT_TRACK: "1", DISABLE_TELEMETRY: "1" };
  try {
    const nodeDirectory = findNodeDirectory(dirname(realpathSync(binary)));
    if (!nodeDirectory) return env;
    const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
    if (!parts.includes(nodeDirectory)) env.PATH = [nodeDirectory, ...parts].join(delimiter);
  } catch {
    // 解析失败时保持原 PATH，交给系统解析。
  }
  return env;
}

export async function installLocalSkill(source: string, vaultRoot: string): Promise<string> {
  const binary = await resolveNpx();
  const args = buildSkillInstallArgs(source);
  return new Promise((resolveInstall, reject) => {
    const child = spawn(binary, args, {
      cwd: vaultRoot,
      env: buildSkillInstallEnv(binary),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 120000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout = `${stdout}${String(chunk)}`.slice(-16000); });
    child.stderr.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-16000); });
    child.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timeout);
      if (code === 0) resolveInstall(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `Skill 安装失败（退出码 ${code ?? -1}）。`));
    });
  });
}
