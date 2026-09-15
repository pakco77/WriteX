import type { TopicIdea, TopicPositioningProfile } from "./types.ts";

export class SerializedTopicMutationQueue {
  private chain: Promise<void> = Promise.resolve();

  run<Snapshot, Result>(input: {
    snapshot: () => Snapshot;
    mutate: () => Result | Promise<Result>;
    persist: () => Promise<void>;
    restore: (snapshot: Snapshot) => void;
  }): Promise<Result> {
    const run = this.chain.then(async () => {
      const snapshot = input.snapshot();
      try {
        const result = await input.mutate();
        await input.persist();
        return result;
      } catch (error) {
        input.restore(snapshot);
        throw error;
      }
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
}

export interface TopicAnalysisSnapshot {
  token: string;
  topicId: string;
  title: string;
  content: string;
  profilePath: string;
  profileHash: string;
  decisionVersion: string;
}

export function topicDecisionVersion(topics: Array<Pick<TopicIdea, "title" | "decision">>): string {
  return JSON.stringify(topics
    .filter((topic): topic is Pick<TopicIdea, "title"> & Required<Pick<TopicIdea, "decision">> => Boolean(topic.decision))
    .map(({ title, decision }) => ({ title, decision })));
}

export function acceptsTopicAnalysisResult(input: {
  snapshot: TopicAnalysisSnapshot;
  requestToken: string | undefined;
  topic: Pick<TopicIdea, "id" | "title" | "content"> | undefined;
  profile: Pick<TopicPositioningProfile, "path" | "contentHash"> | undefined;
  file: { path: string; contentHash: string } | undefined;
  decisionVersion: string;
}): boolean {
  const { snapshot, topic, profile, file } = input;
  return input.requestToken === snapshot.token
    && topic?.id === snapshot.topicId
    && topic.title === snapshot.title
    && topic.content === snapshot.content
    && profile?.path === snapshot.profilePath
    && profile.contentHash === snapshot.profileHash
    && file?.path === snapshot.profilePath
    && file.contentHash === snapshot.profileHash
    && input.decisionVersion === snapshot.decisionVersion;
}
