import assert from "node:assert/strict";
import test from "node:test";
import { SerializedTopicMutationQueue, acceptsTopicAnalysisResult, topicDecisionVersion } from "../src/topicMutation.ts";

test("a failed topic transaction rolls back only before the following queued mutation begins", async () => {
  const state = { topics: ["old"] };
  const queue = new SerializedTopicMutationQueue();
  let rejectFirstSave!: (error: Error) => void;
  const firstSave = new Promise<void>((_resolve, reject) => { rejectFirstSave = reject; });
  const failed = queue.run({
    snapshot: () => [...state.topics],
    mutate: () => { state.topics = ["failed"]; },
    persist: () => firstSave,
    restore: snapshot => { state.topics = snapshot; },
  });
  const succeeded = queue.run({
    snapshot: () => [...state.topics],
    mutate: () => { state.topics = [...state.topics, "saved"]; },
    persist: async () => undefined,
    restore: snapshot => { state.topics = snapshot; },
  });
  rejectFirstSave(new Error("disk full"));
  await assert.rejects(failed, /disk full/);
  await succeeded;
  assert.deepEqual(state.topics, ["old", "saved"]);
});

test("a late analysis result requires current ownership plus unchanged topic, profile file bytes, and decision version", () => {
  const decisions = [{ title: "旧选题", decision: { value: "adopt" as const, correction: "保留一手经验", updatedAt: 1 } }];
  const snapshot = { token: "request-1", topicId: "topic-1", title: "原题", content: "原材料", profilePath: "定位.md", profileHash: "old", decisionVersion: topicDecisionVersion(decisions) };
  const current = { id: "topic-1", title: "原题", content: "原材料" };
  const accepted = { snapshot, requestToken: "request-1", topic: current, profile: { path: "定位.md", contentHash: "old" }, file: { path: "定位.md", contentHash: "old" }, decisionVersion: topicDecisionVersion(decisions) };
  assert.equal(acceptsTopicAnalysisResult(accepted), true);
  assert.equal(acceptsTopicAnalysisResult({ ...accepted, requestToken: "request-2" }), false);
  assert.equal(acceptsTopicAnalysisResult({ ...accepted, file: { path: "定位.md", contentHash: "new" } }), false);
  assert.equal(acceptsTopicAnalysisResult({ ...accepted, topic: { ...current, title: "已改名" } }), false);
  assert.equal(acceptsTopicAnalysisResult({ ...accepted, decisionVersion: topicDecisionVersion([{ title: "旧选题", decision: { value: "adopt", correction: "用户已纠偏", updatedAt: 2 } }]) }), false);
});
