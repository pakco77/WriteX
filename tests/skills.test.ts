import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as skillsModule from "../src/skills.ts";

const { discoverLocalSkills } = skillsModule;

async function writeSkill(directory: string, name: string, description = `${name} description`): Promise<string> {
  await mkdir(directory, { recursive: true });
  const skillFile = join(directory, "SKILL.md");
  await writeFile(skillFile, `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
  return skillFile;
}

async function symlinkDirectory(
  t: { skip(message?: string): void },
  target: string,
  path: string,
): Promise<boolean> {
  try {
    await symlink(target, path, "dir");
    return true;
  } catch (error) {
    if (["EACCES", "EPERM", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("directory symlinks are unavailable on this platform");
      return false;
    }
    throw error;
  }
}

test("a Vault-root article discovers a nested project Skill", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSkill(join(root, "projects", "writing", ".agents", "skills", "human-writing"), "human-writing");

  const skills = await discoverLocalSkills(root, "article.md");

  assert.deepEqual(skills.map(skill => skill.name), ["human-writing"]);
});

test("the current project sorts ahead of other Vault projects", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSkill(join(root, "current", ".agents", "skills", "z-current"), "z-current");
  await writeSkill(join(root, "other", ".agents", "skills", "a-other"), "a-other");
  assert.equal(typeof skillsModule.VaultSkillIndex, "function");

  const skills = await new skillsModule.VaultSkillIndex(root).discover("current/article.md");

  assert.deepEqual(skills.map(skill => [skill.name, skill.scope]), [
    ["z-current", "current"],
    ["a-other", "vault"],
  ]);
});

test("realpath deduplicates Skill symlinks while legacy aliases still resolve", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillDirectory = join(root, "project", ".agents", "skills", "shared");
  const canonicalFile = await writeSkill(skillDirectory, "shared");
  const aliasDirectory = join(root, "project", ".claude", "skills", "legacy-shared");
  await mkdir(join(root, "project", ".claude", "skills"), { recursive: true });
  if (!await symlinkDirectory(t, skillDirectory, aliasDirectory)) return;

  const skills = await new skillsModule.VaultSkillIndex(root).discover("project/article.md");

  const realCanonicalFile = await realpath(canonicalFile);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.skillFile, realCanonicalFile);
  assert.equal(skills[0]?.id, realCanonicalFile);
  assert.deepEqual(
    skills[0]?.aliases,
    [canonicalFile, join(aliasDirectory, "SKILL.md")].filter(path => path !== realCanonicalFile),
  );
  assert.equal(typeof skillsModule.findLocalSkillByPath, "function");
  assert.equal(skillsModule.findLocalSkillByPath(skills, join(aliasDirectory, "SKILL.md")), skills[0]);
});

test("near ancestors win first, then Skills sort stably by name and source", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSkill(join(root, "project", "drafts", ".agents", "skills", "z-near"), "z-near");
  await writeSkill(join(root, "project", "drafts", ".codex", "skills", "a-near"), "a-near");
  await writeSkill(join(root, "project", ".agents", "skills", "a-far"), "a-far");
  await writeSkill(join(root, "z-owner", ".agents", "skills", "same"), "same");
  await writeSkill(join(root, "a-owner", ".claude", "skills", "same"), "same");

  const skills = await new skillsModule.VaultSkillIndex(root).discover("project/drafts/article.md");

  assert.deepEqual(skills.map(skill => skill.name), ["a-near", "z-near", "a-far", "same", "same"]);
  assert.deepEqual(skills.map(skill => skill.scope), ["current", "current", "current", "vault", "vault"]);
  assert.match(skills[0]?.rootLabel ?? "", /^当前项目 · project\/drafts · Codex$/);
  assert.match(skills[2]?.rootLabel ?? "", /^当前项目 · project · Agent$/);
  assert.deepEqual(skills.slice(3).map(skill => skill.rootLabel), [
    "Vault 其他项目 · a-owner · Claude",
    "Vault 其他项目 · z-owner · Agent",
  ]);
  assert.notEqual(skills[3]?.skillFile, skills[4]?.skillFile);
});

test("the scanner stays inside real visible Vault directories", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  const outside = await mkdtemp(join(tmpdir(), "writex-skills-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await writeSkill(join(root, "project", ".agents", "skills", "valid"), "valid");
  await writeSkill(join(root, ".hidden", ".agents", "skills", "hidden"), "hidden");
  for (const hidden of [".obsidian", ".git", ".trash", ".writex"]) {
    await writeSkill(join(root, hidden, ".agents", "skills", hidden.slice(1)), hidden.slice(1));
  }
  await writeSkill(join(root, "node_modules", "package", ".agents", "skills", "dependency"), "dependency");
  const outsideSkill = join(outside, ".agents", "skills", "outside");
  await writeSkill(outsideSkill, "outside");

  const linkedProject = join(root, "linked-project");
  if (!await symlinkDirectory(t, outside, linkedProject)) return;

  const markerTarget = join(root, ".targets", "agents");
  await writeSkill(join(markerTarget, "skills", "marker-link"), "marker-link");
  await mkdir(join(root, "marker-project"), { recursive: true });
  if (!await symlinkDirectory(t, markerTarget, join(root, "marker-project", ".agents"))) return;

  const skillsTarget = join(root, ".targets", "skills");
  await writeSkill(join(skillsTarget, "skills-link"), "skills-link");
  await mkdir(join(root, "skills-project", ".agents"), { recursive: true });
  if (!await symlinkDirectory(t, skillsTarget, join(root, "skills-project", ".agents", "skills"))) return;

  const externalAliasRoot = join(root, "project", ".codex", "skills");
  await mkdir(externalAliasRoot, { recursive: true });
  if (!await symlinkDirectory(t, outsideSkill, join(externalAliasRoot, "external-alias"))) return;

  const skills = await new skillsModule.VaultSkillIndex(root).discover("article.md");

  assert.deepEqual(skills.map(skill => skill.name), ["valid"]);
});

test("a duplicated real Skill uses the occurrence nearest to the active note", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalDirectory = join(root, "project", ".agents", "skills", "shared");
  await writeSkill(canonicalDirectory, "shared");
  const nearRoot = join(root, "project", "drafts", ".claude", "skills");
  await mkdir(nearRoot, { recursive: true });
  if (!await symlinkDirectory(t, canonicalDirectory, join(nearRoot, "shared-alias"))) return;

  const skills = await new skillsModule.VaultSkillIndex(root).discover("project/drafts/article.md");

  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.scope, "current");
  assert.equal(skills[0]?.rootLabel, "当前项目 · project/drafts · Claude");
});

test("the current Skill scan predicate rejects stale success and stale failure side effects", () => {
  assert.equal(typeof skillsModule.isCurrentSkillScan, "function");
  const effects: string[] = [];
  const settle = (requestId: number, notePath: string, outcome: string): void => {
    if (!skillsModule.isCurrentSkillScan(requestId, notePath, 2, "new.md")) return;
    effects.push(outcome);
  };

  settle(1, "old.md", "stale-success");
  settle(1, "old.md", "stale-failure");
  settle(2, "new.md", "current-success");

  assert.deepEqual(effects, ["current-success"]);
});

test("invalid frontmatter is skipped and files over 128 KiB are never read", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillsRoot = join(root, ".agents", "skills");
  await writeSkill(join(skillsRoot, "valid"), "valid", "usable");
  await mkdir(join(skillsRoot, "missing-name"), { recursive: true });
  await writeFile(join(skillsRoot, "missing-name", "SKILL.md"), "---\ndescription: missing name\n---\n");
  await mkdir(join(skillsRoot, "missing-description"), { recursive: true });
  await writeFile(join(skillsRoot, "missing-description", "SKILL.md"), "---\nname: missing-description\n---\n");
  await mkdir(join(skillsRoot, "blank"), { recursive: true });
  await writeFile(join(skillsRoot, "blank", "SKILL.md"), "");
  await mkdir(join(skillsRoot, "oversized"), { recursive: true });
  await writeFile(join(skillsRoot, "oversized", "SKILL.md"), "x".repeat(128 * 1024 + 1));
  const reads: string[] = [];
  const index = new skillsModule.VaultSkillIndex(root, async path => {
    reads.push(path);
    return readFile(path, "utf8");
  });

  const skills = await index.discover("article.md");

  assert.deepEqual(skills.map(skill => skill.name), ["valid"]);
  assert.equal(reads.some(path => path.endsWith("/oversized/SKILL.md")), false);
  assert.equal(skills[0]?.source.includes("description: usable"), true);
  assert.match(skills[0]?.sourceHash ?? "", /^[a-f0-9]{64}$/);
});

test("an existing but invalid active Skill is distinguishable from a missing file", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillFile = await writeSkill(join(root, ".agents", "skills", "drafting"), "drafting");
  const index = new skillsModule.VaultSkillIndex(root);

  await index.discover("article.md");
  assert.deepEqual(index.getPathStatus(skillFile), { kind: "valid" });

  await writeFile(skillFile, "---\nname: drafting\n---\n# still being edited\n");
  assert.deepEqual(await index.discover("article.md", { refresh: true }), []);
  assert.deepEqual(index.getPathStatus(skillFile), {
    kind: "invalid",
    reason: "SKILL.md 缺少 description。",
  });

  await rm(skillFile);
  await index.discover("article.md", { refresh: true });
  assert.deepEqual(index.getPathStatus(skillFile), { kind: "missing" });
});

test("changing notes only reorders the cached Vault index without rereading Skill files", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSkill(join(root, "project", ".agents", "skills", "cached"), "cached");
  let reads = 0;
  const index = new skillsModule.VaultSkillIndex(root, async path => {
    reads += 1;
    return readFile(path, "utf8");
  });

  const current = await index.discover("project/first.md");
  const elsewhere = await index.discover("elsewhere/second.md");

  assert.equal(current[0]?.scope, "current");
  assert.equal(elsewhere[0]?.scope, "vault");
  assert.equal(reads, 1);
});

test("refresh and invalidate reuse unchanged content but reread changed size or mtime", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillDirectory = join(root, "project", ".agents", "skills", "cached");
  const skillFile = await writeSkill(skillDirectory, "cache-one");
  let reads = 0;
  const index = new skillsModule.VaultSkillIndex(root, async path => {
    reads += 1;
    return readFile(path, "utf8");
  });

  const first = await index.discover("project/first.md");
  const unchanged = await index.discover("project/first.md", { refresh: true });

  assert.equal(reads, 1);
  assert.equal(unchanged[0]?.sourceHash, first[0]?.sourceHash);

  await writeFile(skillFile, "---\nname: cache-two-longer\ndescription: changed content\n---\n# changed\n");
  const changed = await index.discover("project/first.md", { refresh: true });

  assert.equal(reads, 2);
  assert.equal(changed[0]?.name, "cache-two-longer");
  assert.notEqual(changed[0]?.sourceHash, first[0]?.sourceHash);

  index.invalidate();
  const rebuilt = await index.discover("project/first.md");
  assert.equal(rebuilt[0]?.name, "cache-two-longer");
  assert.equal(reads, 2);
});

test("integrity errors reject a refresh without committing its partial index", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillsRoot = join(root, ".agents", "skills");
  await writeSkill(join(skillsRoot, "stable"), "stable");
  const index = new skillsModule.VaultSkillIndex(root, async path => {
    if (path.endsWith("/z-broken/SKILL.md")) {
      throw Object.assign(new Error("simulated disk failure"), { code: "EIO" });
    }
    return readFile(path, "utf8");
  });
  assert.deepEqual((await index.discover("article.md")).map(skill => skill.name), ["stable"]);
  await writeSkill(join(skillsRoot, "a-partial"), "partial");
  await writeSkill(join(skillsRoot, "z-broken"), "broken");

  await assert.rejects(
    index.discover("article.md", { refresh: true }),
    /simulated disk failure/,
  );

  assert.deepEqual((await index.discover("article.md")).map(skill => skill.name), ["stable"]);
});

test("overlapping refreshes only let the newest generation commit", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSkill(join(root, ".agents", "skills", "racing"), "disk-placeholder");
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
  let reads = 0;
  const index = new skillsModule.VaultSkillIndex(root, async () => {
    reads += 1;
    if (reads === 1) {
      markFirstStarted();
      await firstGate;
      return "---\nname: stale\ndescription: stale scan\n---\n";
    }
    return "---\nname: newest\ndescription: newest scan\n---\n";
  });

  const staleScan = index.discover("article.md", { refresh: true });
  await firstStarted;
  const newestScan = index.discover("article.md", { refresh: true });
  assert.equal((await newestScan)[0]?.name, "newest");
  releaseFirst();
  assert.equal((await staleScan)[0]?.name, "newest");

  assert.equal((await index.discover("article.md"))[0]?.name, "newest");
});

test("an initial no-refresh waiter follows a superseding refresh instead of failing early", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSkill(join(root, ".agents", "skills", "racing"), "disk-placeholder");
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let releaseNewest!: () => void;
  const newestGate = new Promise<void>(resolve => { releaseNewest = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
  let markNewestStarted!: () => void;
  const newestStarted = new Promise<void>(resolve => { markNewestStarted = resolve; });
  let reads = 0;
  const index = new skillsModule.VaultSkillIndex(root, async () => {
    reads += 1;
    if (reads === 1) {
      markFirstStarted();
      await firstGate;
      return "---\nname: stale\ndescription: stale scan\n---\n";
    }
    markNewestStarted();
    await newestGate;
    return "---\nname: newest\ndescription: newest scan\n---\n";
  });

  const initialRefresh = index.discover("article.md", { refresh: true });
  await firstStarted;
  const waiter = index.discover("article.md");
  const waiterOutcome = waiter.then(
    value => ({ status: "fulfilled" as const, value }),
    error => ({ status: "rejected" as const, error }),
  );
  const newestRefresh = index.discover("article.md", { refresh: true });
  await newestStarted;
  releaseFirst();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await Promise.race([
    waiterOutcome.then(result => result.status),
    new Promise<"pending">(resolve => setImmediate(() => resolve("pending"))),
  ])), "pending");

  releaseNewest();
  assert.equal((await initialRefresh)[0]?.name, "newest");
  assert.equal((await newestRefresh)[0]?.name, "newest");
  const result = await waiterOutcome;
  assert.equal(result.status, "fulfilled");
  if (result.status === "fulfilled") assert.equal(result.value[0]?.name, "newest");
});

test("superseded initial callers receive the newest scan's real failure", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSkill(join(root, ".agents", "skills", "racing"), "disk-placeholder");
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
  let reads = 0;
  const index = new skillsModule.VaultSkillIndex(root, async () => {
    reads += 1;
    if (reads === 1) {
      markFirstStarted();
      await firstGate;
      return "---\nname: stale\ndescription: stale scan\n---\n";
    }
    throw Object.assign(new Error("latest scan failure"), { code: "EIO" });
  });

  const initialRefresh = index.discover("article.md", { refresh: true });
  await firstStarted;
  const waiter = index.discover("article.md");
  const newestRefresh = index.discover("article.md", { refresh: true });
  const newestOutcome = newestRefresh.then(
    () => "fulfilled",
    error => `rejected:${(error as Error).message}`,
  );
  assert.equal(await newestOutcome, "rejected:latest scan failure");
  releaseFirst();

  await assert.rejects(initialRefresh, /latest scan failure/);
  await assert.rejects(waiter, /latest scan failure/);
});
