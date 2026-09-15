import assert from "node:assert/strict";
import test from "node:test";
import { agentModelOptions, mergeDiscoveredModels, parseClaudeInitializeModels, parseWorkBuddyModels } from "../src/modelCatalog.ts";
import { migrateSettings } from "../src/types.ts";
import { CodexRuntime } from "../src/codex.ts";
import { ChatAgentRuntime } from "../src/chatAgents.ts";
import { DEFAULT_SETTINGS } from "../src/types.ts";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("dynamic model options retain an explicit unavailable selection instead of resetting it", () => {
  const cache = mergeDiscoveredModels({}, "codex", [{ model: "gpt-6-astra", displayName: "GPT-6 Astra", hidden: false }], 10);
  assert.deepEqual(agentModelOptions("codex", cache, "gpt-5.6-sol").map(item => item.value), ["", "gpt-6-astra", "gpt-5.6-sol"]);
});

test("WorkBuddy discovery reads the explicit supported list, including plain alphanumeric model IDs", () => {
  const help = [
    "--model <model> selects a model; prose-version-2026 must not be a model",
    "Currently supported: (hy3, hy4-preview, glm-5.3, deepseek-v4-pro)",
  ].join("\n");
  assert.deepEqual(parseWorkBuddyModels(help), ["hy3", "hy4-preview", "glm-5.3", "deepseek-v4-pro"]);
  assert.deepEqual(parseWorkBuddyModels("Currently supported: hy3|hy4-preview"), ["hy3", "hy4-preview"]);
  assert.deepEqual(parseWorkBuddyModels("Currently supported: ()"), []);
  assert.throws(() => parseWorkBuddyModels("Usage: workbuddy [options]\n--model <model>"), /无法识别 WorkBuddy 模型列表/);
  assert.throws(() => parseWorkBuddyModels("Currently supported:\nOptions"), /无法识别 WorkBuddy 模型列表/);
  assert.throws(() => parseWorkBuddyModels("Currently supported:"), /无法识别 WorkBuddy 模型列表/);
  assert.throws(() => parseWorkBuddyModels("Currently supported: [hy3, hy4]"), /无法识别 WorkBuddy 模型列表/);
  assert.throws(() => parseWorkBuddyModels("Currently supported: (temporarily unavailable)"), /无法识别 WorkBuddy 模型列表/);
});

test("WorkBuddy discovery rejects a zero-exit help response without a supported catalog", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-workbuddy-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "fake-workbuddy");
  await writeFile(executable, "#!/usr/bin/env node\nconsole.log('Usage: workbuddy [options]\\n--model <model>');", "utf8");
  await chmod(executable, 0o755);
  const runtime = new ChatAgentRuntime({} as CodexRuntime, () => ({ ...DEFAULT_SETTINGS, workbuddyPath: executable }));
  await assert.rejects(runtime.listWorkBuddyModels(), /无法识别 WorkBuddy 模型列表/);
});

test("Claude initialize parser reads the official nested request ID and distinguishes empty, errors, and malformed responses", () => {
  const line = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "writex-models", response: { models: [{ value: "sonnet", displayName: "Sonnet" }, { value: "opus", displayName: "Opus" }] } } });
  assert.deepEqual(parseClaudeInitializeModels(line), { kind: "models", models: [{ value: "sonnet", label: "Sonnet" }, { value: "opus", label: "Opus" }] });
  assert.deepEqual(parseClaudeInitializeModels(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "other", response: { models: [] } } })), { kind: "ignore" });
  assert.deepEqual(parseClaudeInitializeModels(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: "writex-models", error: { message: "not authenticated" } } })), { kind: "error", message: "not authenticated" });
  assert.deepEqual(parseClaudeInitializeModels(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "writex-models", response: { models: [] } } })), { kind: "models", models: [] });
  assert.deepEqual(parseClaudeInitializeModels(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "writex-models", response: { models: [{ value: "sonnet" }] } } })), { kind: "malformed" });
  assert.deepEqual(parseClaudeInitializeModels("null"), { kind: "malformed" });
});

test("Codex model catalog waits for initialize and follows pagination", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-catalog-")); t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "fake-codex");
  await writeFile(executable, `#!/usr/bin/env node
let page=0; process.stdin.on('data', chunk => { for (const line of String(chunk).trim().split('\\n')) { const request=JSON.parse(line); if(request.method==='initialize') console.log(JSON.stringify({id:1,result:{}})); if(request.method==='model/list') { page++; console.log(JSON.stringify({id:2,result:{data:[{model:'m'+page,displayName:'M'+page,hidden:false}],nextCursor:page===1?'next':null}})); } } });`, "utf8");
  await chmod(executable, 0o755);
  const models = await new CodexRuntime(() => executable).listModels();
  assert.deepEqual(models.map(model => model.model), ["m1", "m2"]);
});

test("settings migration preserves explicit models unknown to a stale catalog", () => {
  const settings = migrateSettings({ codexModel: "gpt-6-astra", claudeModel: "claude-future", workbuddyModel: "glm-5.3", topicAnalysisModel: "gpt-6-astra" });
  assert.equal(settings.codexModel, "gpt-6-astra");
  assert.equal(settings.claudeModel, "claude-future");
  assert.equal(settings.workbuddyModel, "glm-5.3");
  assert.equal(settings.topicAnalysisModel, "gpt-6-astra");
});

test("Claude discovery ignores another request then accepts a valid empty catalog, while explicit initialize errors reject", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-claude-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "fake-claude");
  const run = async (responses: unknown[]) => {
    await writeFile(executable, `#!/usr/bin/env node
process.stdin.once('data', () => { for (const response of ${JSON.stringify(responses)}) process.stdout.write(JSON.stringify(response) + '\\n'); setInterval(() => {}, 1000); });`, "utf8");
    await chmod(executable, 0o755);
    return new ChatAgentRuntime({} as CodexRuntime, () => ({ ...DEFAULT_SETTINGS, claudePath: executable }));
  };
  const empty = await run([
    { type: "control_response", response: { subtype: "success", request_id: "other", response: { models: [{ value: "wrong" }] } } },
    { type: "control_response", response: { subtype: "success", request_id: "writex-models", response: { models: [] } } },
  ]);
  assert.deepEqual(await empty.listClaudeModels(), []);
  const rejected = await run([{ type: "control_response", response: { subtype: "error", request_id: "writex-models", error: { message: "denied" } } }]);
  await assert.rejects(rejected.listClaudeModels(), /denied/);
});
