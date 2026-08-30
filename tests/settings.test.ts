import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  migratePersistedData,
  migrateSettings,
  type AgentSettings,
  type PersistedData,
} from "../src/types.ts";
import { readFile } from "node:fs/promises";

test("v0.1 settings migrate without losing existing values", () => {
  const legacy = {
    codexPath: "",
    codexModel: "gpt-5.6-sol",
    maxContextChars: 30000,
    imageModel: "gpt-image-2",
    imageSize: "1536x1024" as const,
    hasImageApiKey: false,
  };

  assert.deepEqual(migrateSettings(legacy), {
    ...DEFAULT_SETTINGS,
    codexModel: "gpt-5.6-sol",
  });
  assert.equal(migrateSettings(legacy).activeChatAgent, "codex");
  assert.equal(migrateSettings(legacy).codexReasoningEffort, "");
  assert.equal(migrateSettings(legacy).claudePath, "");
  assert.equal(migrateSettings(legacy).workbuddyPath, "");
});

test("persisted settings expose only relay configuration state, never the key", () => {
  const settings: AgentSettings = migrateSettings({
    relayUrl: "https://relay.example.com",
    defaultWeChatAuthor: "Write",
    hasRelayKey: true,
  });

  assert.equal(settings.relayUrl, "https://relay.example.com");
  assert.equal(settings.defaultWeChatAuthor, "Write");
  assert.equal(settings.hasRelayKey, true);
  assert.equal("relayKey" in settings, false);
  assert.equal("appid" in settings, false);
  assert.equal("appsecret" in settings, false);
});

test("v0.5 defaults to self-hosted Relay and persists no cloud token, invite, or AppSecret", () => {
  const settings: AgentSettings = migrateSettings({
    syncRoute: "write-cloud",
    cloudUrl: "https://cloud.example.com",
    hasCloudToken: true,
    cloudConnectionId: "con-1",
    cloudAccountName: "测试公众号",
    cloudAccountId: "acct-1",
  });
  assert.equal(DEFAULT_SETTINGS.syncRoute, "self-hosted");
  assert.equal(DEFAULT_SETTINGS.cloudUrl, "https://cloud.write.pakcochan.com");
  assert.equal(migrateSettings({ cloudUrl: "" }).cloudUrl, DEFAULT_SETTINGS.cloudUrl);
  assert.equal(settings.syncRoute, "write-cloud");
  assert.equal(settings.hasCloudToken, true);
  assert.equal("cloudToken" in settings, false);
  assert.equal("inviteCode" in settings, false);
  assert.equal("appsecret" in settings, false);
});

test("Cloud lifecycle UI distinguishes local disconnect from server-side revocation and secret deletion", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /clearCloudCredentials/);
  assert.match(main, /revokeCurrentInstallation/);
  assert.match(main, /deleteConnection/);
  assert.match(main, /进行中的同步或待人工核查结果/);
});

test("invalid persisted Agent and removed Luna model fall back visibly to Codex default", () => {
  const settings = migrateSettings({
    activeChatAgent: "unknown" as AgentSettings["activeChatAgent"],
    codexModel: "gpt-5.6-luna",
    codexReasoningEffort: "impossible" as AgentSettings["codexReasoningEffort"],
  });
  assert.equal(settings.activeChatAgent, "codex");
  assert.equal(settings.codexModel, "");
  assert.equal(settings.codexReasoningEffort, "");
});

test("v1 data migrates to v6 without losing Chat, assets, sessions, skills, feedback, Relay, or legacy render evidence", () => {
  const legacy = {
    version: 1,
    settings: { ...DEFAULT_SETTINGS, codexModel: "gpt-5.6-sol", relayUrl: "https://relay.example.com" },
    notes: {
      "a.md": {
        messages: [{ id: "m1", role: "assistant", kind: "text", content: "answer", createdAt: 1, feedback: "up" }],
        assets: [{ id: "asset1", filePath: "a.png", name: "a.png", mimeType: "image/png", source: "generated", createdAt: 2, prompt: "p", provider: "agent", model: "gpt-image-2", writeCredits: 0 }],
        codexThreadId: "legacy-thread",
        agentSessions: { codex: "codex-session", claude: "claude-session" },
        archivedConversations: [{ id: "archive1", title: "old", createdAt: 3, updatedAt: 4, messages: [] }],
        activeSkillPath: "/skills/human-writing/SKILL.md",
        renderSkillPath: "/skills/gzh-design/SKILL.md",
        previewMode: "skill",
        skillRender: {
          html: "<section>legacy</section>",
          sourceHash: "source-hash",
          skillPath: "/skills/gzh-design/SKILL.md",
          skillName: "gzh-design",
          themeId: "moyu-green",
          generatedAt: 5,
          validationSummary: "ok",
        },
      },
      "b.md": { messages: [], assets: [] },
    },
    feedbackMemory: [{ messageId: "m1", rating: "up", createdAt: 6, agent: "codex", model: "gpt-5.6-sol", requestChars: 1, responseChars: 6, paragraphCount: 1, listItemCount: 0 }],
    wechatImageCache: { key: { sourceSha256: "s", uploadSha256: "u", url: "https://mmbiz.qpic.cn/a", accountId: "acct", relayUrl: "https://relay.example.com", cachedAt: 7 } },
    relayAccountBindings: { "https://relay.example.com": { accountId: "acct", accountName: "公众号", relayUrl: "https://relay.example.com", verifiedAt: 8 } },
  };

  const migrated = migratePersistedData(legacy) as PersistedData;
  assert.equal(migrated.version, 6);
  assert.deepEqual(migrated.topics, []);
  assert.equal(migrated.notes["a.md"].themeId, "moyu-green");
  assert.equal(migrated.notes["b.md"].themeId, "default");
  assert.deepEqual(migrated.notes["a.md"].messages, legacy.notes["a.md"].messages);
  assert.deepEqual(migrated.notes["a.md"].assets, legacy.notes["a.md"].assets);
  assert.deepEqual(migrated.notes["a.md"].agentSessions, legacy.notes["a.md"].agentSessions);
  assert.deepEqual(migrated.notes["a.md"].archivedConversations, legacy.notes["a.md"].archivedConversations);
  assert.deepEqual(migrated.notes["a.md"].skillRender, legacy.notes["a.md"].skillRender);
  assert.deepEqual(migrated.feedbackMemory, legacy.feedbackMemory);
  assert.deepEqual(migrated.wechatImageCache, legacy.wechatImageCache);
  assert.deepEqual(migrated.relayAccountBindings, legacy.relayAccountBindings);
});

test("v3 data migrates to v6 and preserves existing local topics", () => {
  const topic = {
    id: "topic-1",
    title: "一次模型更新，杀死了我的 AI App",
    content: "完整选题材料",
    status: "idea" as const,
    sourceNotePath: "a.md",
    sourceMessageId: "m1",
    sourceAgent: "codex" as const,
    sourceModel: "gpt-5.6-sol",
    createdAt: 10,
    updatedAt: 10,
  };

  const migrated = migratePersistedData({
    version: 3,
    settings: DEFAULT_SETTINGS,
    notes: {},
    topics: [topic],
  });

  assert.equal(migrated.version, 6);
  assert.deepEqual(migrated.topics, [{ ...topic, sourceKind: "chat" }]);
});

test("v2 data migrates independently to v6 without dropping notes or old topic fields", () => {
  const migrated = migratePersistedData({
    version: 2, settings: { codexModel: "gpt-5.6-sol" },
    notes: { "old.md": { messages: [{ id: "m", role: "assistant", kind: "text", content: "保留", createdAt: 1 }], assets: [] } },
    topics: [{ id: "t", title: "旧选题", content: "材料", status: "idea", createdAt: 1, updatedAt: 2 }],
  });
  assert.equal(migrated.version, 6);
  assert.equal(migrated.notes["old.md"]?.messages[0]?.content, "保留");
  assert.deepEqual(migrated.topics, [{ id: "t", title: "旧选题", content: "材料", status: "idea", createdAt: 1, updatedAt: 2, sourceKind: "chat" }]);
});

test("v5 data migrates to v6 with one optional writing style profile and untouched message history", () => {
  const migrated = migratePersistedData({
    version: 5, settings: DEFAULT_SETTINGS,
    notes: { "a.md": { messages: [{ id: "m", role: "assistant", kind: "text", content: "保留", createdAt: 1 }], assets: [] } },
    topics: [],
  });
  assert.equal(migrated.version, 6);
  assert.equal(migrated.writingStyleProfile, undefined);
  assert.equal(migrated.notes["a.md"]?.writingStyleEnabled, undefined);
  assert.equal(migrated.notes["a.md"]?.messages[0]?.content, "保留");
});

test("v6 migration rejects an invalid optional style and normalizes a confirmed one", () => {
  assert.equal(migratePersistedData({ version: 6, settings: DEFAULT_SETTINGS, notes: {}, topics: [], writingStyleProfile: { markdown: "" } }).writingStyleProfile, undefined);
  const profile = migratePersistedData({
    version: 6, settings: DEFAULT_SETTINGS, notes: {}, topics: [],
    writingStyleProfile: { markdown: "保留判断。", sources: [{ kind: "note", filePath: "a.md", sourceHash: "x", capturedAt: 1, characterCount: 5, includedChars: 5 }], revision: 2, agent: "claude", model: "sonnet", createdAt: 1, updatedAt: 2 },
  }).writingStyleProfile;
  assert.deepEqual(profile, { markdown: "保留判断。", sources: [{ kind: "note", filePath: "a.md", sourceHash: "x", capturedAt: 1, characterCount: 5, includedChars: 5 }], revision: 2, agent: "claude", model: "sonnet", createdAt: 1, updatedAt: 2 });
});

test("v4 manual topics remain explicit without fabricated Chat identity", () => {
  const topic = {
    id: "manual-1",
    title: "一句刚冒出来的念头",
    content: "一句刚冒出来的念头",
    sourceKind: "manual" as const,
    sourceNotePath: "事件.md",
    createdAt: 10,
    updatedAt: 10,
    status: "done" as const,
  };

  const migrated = migratePersistedData({
    version: 4,
    settings: DEFAULT_SETTINGS,
    notes: {},
    topics: [topic],
  });

  assert.deepEqual(migrated.topics, [topic]);
  assert.equal(migrated.topics[0]?.sourceMessageId, undefined);
  assert.equal(migrated.topics[0]?.sourceAgent, undefined);
});

test("every v1-v5 fixture retains persisted writing records and integrations while invalid optional v0.58 fields are ignored", () => {
  const fixture = {
    settings: { ...DEFAULT_SETTINGS, codexModel: "gpt-5.6-sol", relayUrl: "https://relay.example.com" },
    notes: {
      "完整.md": {
        messages: [{ id: "message", role: "assistant", kind: "text", content: "回答", createdAt: 1, attachments: [{ id: "attachment", name: "a.png", filePath: "attachments/a.png", mimeType: "image/png", byteLength: 9, kind: "image" }], writingStyle: { revision: 1, sourceHash: "style" } }],
        assets: [{ id: "image", filePath: "images/a.png", name: "a.png", mimeType: "image/png", source: "manual", createdAt: 2 }],
        themeId: "moyu-green", agentSessions: { codex: "session" }, codexThreadId: "legacy", writingStyleEnabled: false,
      },
    },
    topics: [{ id: "topic", title: "旧选题", content: "材料", sourceKind: "manual" as const, status: "done" as const, createdAt: 3, updatedAt: 4 }],
    feedbackMemory: [{ messageId: "message", rating: "up" as const, createdAt: 5, agent: "codex" as const, requestChars: 1, responseChars: 2, paragraphCount: 1, listItemCount: 0 }],
    relayAccountBindings: { relay: { relayUrl: "https://relay.example.com", accountId: "account", accountName: "公众号", verifiedAt: 6 } },
    wechatImageCache: { image: { sourceSha256: "source", uploadSha256: "upload", url: "https://mmbiz.qpic.cn/a", accountId: "account", relayUrl: "https://relay.example.com", cachedAt: 7 } },
  };
  for (const version of [1, 2, 3, 4, 5]) {
    const migrated = migratePersistedData({ version, ...structuredClone(fixture), writingStyleProfile: { markdown: 99 }, notes: { ...fixture.notes, "无效.md": { messages: [], assets: [], writingStyleEnabled: "yes" } } });
    assert.equal(migrated.version, 6, `v${version}`);
    assert.deepEqual(migrated.notes["完整.md"], fixture.notes["完整.md"], `v${version} note`);
    assert.deepEqual(migrated.topics, fixture.topics, `v${version} topics`);
    assert.deepEqual(migrated.feedbackMemory, fixture.feedbackMemory, `v${version} feedback`);
    assert.deepEqual(migrated.relayAccountBindings, fixture.relayAccountBindings, `v${version} relay`);
    assert.deepEqual(migrated.wechatImageCache, fixture.wechatImageCache, `v${version} WeChat cache`);
    assert.equal(migrated.writingStyleProfile, undefined, `v${version} invalid style`);
    assert.equal(migrated.notes["无效.md"]?.writingStyleEnabled, undefined, `v${version} invalid toggle`);
  }
});
