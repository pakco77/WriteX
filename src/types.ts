export interface CursorPosition {
  line: number;
  ch: number;
}

export interface SelectionContext {
  filePath: string;
  fileName: string;
  text: string;
  from: CursorPosition;
  to: CursorPosition;
  capturedAt: number;
}

export type MessageRole = "user" | "assistant";
export type MessageKind = "text" | "image";
export type ChatMode = "chat" | "plan";
export type ChatAgentId = "codex" | "claude" | "workbuddy";
export type CodexReasoningEffort = "" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface ChatSkillSnapshot {
  name: string;
  path: string;
  sourceHash: string;
}

export interface WritingStyleSourceRef {
  kind: "note" | "selection";
  filePath?: string;
  sourceHash: string;
  capturedAt: number;
  characterCount: number;
  includedChars: number;
}

export interface WritingStyleSkillExport {
  path: string;
  contentHash: string;
  exportedAt: number;
}

export interface WritingStyleProfile {
  markdown: string;
  sources: WritingStyleSourceRef[];
  revision: number;
  agent: ChatAgentId;
  model: string;
  createdAt: number;
  updatedAt: number;
  lastSkillExport?: WritingStyleSkillExport;
}

export interface WritingStyleSnapshot {
  revision: number;
  sourceHash: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  filePath: string;
  mimeType: string;
  byteLength: number;
  kind: "image" | "file";
}

export interface ChatAttachmentContext extends ChatAttachment {
  absolutePath: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  createdAt: number;
  context?: SelectionContext;
  attachments?: ChatAttachment[];
  assetId?: string;
  mode?: ChatMode;
  agent?: ChatAgentId;
  model?: string;
  reasoningEffort?: Exclude<CodexReasoningEffort, "">;
  webSearchCount?: number;
  relatedNotePaths?: string[];
  skill?: ChatSkillSnapshot;
  writingStyle?: WritingStyleSnapshot;
  feedback?: "up" | "down";
}

export interface ChatFeedbackMemoryEntry {
  messageId: string;
  rating: "up" | "down";
  createdAt: number;
  agent: ChatAgentId;
  model?: string;
  skillName?: string;
  requestChars: number;
  responseChars: number;
  paragraphCount: number;
  listItemCount: number;
}

export type TopicStatus = "idea" | "writing" | "done";
export type TopicSourceKind = "manual" | "chat";
export type TopicDecisionValue = "adopt" | "defer" | "dismiss";
export interface TopicRating {
  stars: 1 | 2 | 3 | 4 | 5;
  detail: string;
  suggestion?: string;
  agent: ChatAgentId;
  model: string;
  profileHash: string;
  analyzedAt: number;
}
export interface TopicDecision {
  value: TopicDecisionValue;
  reason?: string;
  correction?: string;
  updatedAt: number;
}
export interface TopicPositioningProfile {
  path: string;
  contentHash: string;
  updatedAt: number;
}
export interface DiscoveredAgentModels {
  fetchedAt: number;
  models: Array<{ value: string; label: string }>;
}

export interface TopicIdea {
  id: string;
  title: string;
  content: string;
  sourceKind: TopicSourceKind;
  sourceNotePath?: string;
  articleNotePath?: string;
  sourceMessageId?: string;
  sourceAgent?: ChatAgentId;
  sourceModel?: string;
  createdAt: number;
  updatedAt: number;
  status?: TopicStatus;
  rating?: TopicRating;
  ratingStale?: boolean;
  decision?: TopicDecision;
}

export interface ArchivedConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  codexThreadId?: string;
  agentSessions?: Partial<Record<ChatAgentId, string>>;
}

export interface SkillRenderResult {
  html: string;
  sourceHash: string;
  skillPath: string;
  skillName: string;
  themeId: string;
  generatedAt: number;
  validationSummary?: string;
}

export type AssetSource = "generated" | "manual" | "original" | "optimized";
export type ImageProvider = "agent" | "openai-api" | "write-cloud";
export type ImageCapability = "unknown" | "available" | "unavailable";
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";
export type SyncRoute = "self-hosted" | "write-cloud";

export interface ImageAsset {
  id: string;
  filePath: string;
  name: string;
  mimeType: string;
  source: AssetSource;
  createdAt: number;
  prompt?: string;
  provider?: ImageProvider;
  model?: string;
  messageId?: string;
  writeCredits?: number;
  relatedOriginalPath?: string;
  relatedOptimizedPath?: string;
  optimizationSummary?: string;
}

export interface ReferencedImageCandidate {
  filePath: string;
  name: string;
  mimeType: string;
}

export function mergeReferencedImageAssets(
  assets: ImageAsset[],
  candidates: ReferencedImageCandidate[],
  createId: () => string = () => `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  now: () => number = Date.now,
): number {
  const knownPaths = new Set(assets.map(asset => asset.filePath));
  let added = 0;
  for (const candidate of candidates) {
    if (knownPaths.has(candidate.filePath)) continue;
    assets.unshift({
      id: createId(),
      filePath: candidate.filePath,
      name: candidate.name,
      mimeType: candidate.mimeType,
      source: "manual",
      createdAt: now(),
      writeCredits: 0,
    });
    knownPaths.add(candidate.filePath);
    added += 1;
  }
  return added;
}

export function ensureOriginalAssetPairs(
  assets: ImageAsset[],
  resolveOriginal: (path: string) => { name: string; mimeType?: string } | null,
  createId: () => string = () => `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): boolean {
  let changed = false;
  for (const optimized of assets.filter(asset => asset.source === "optimized" && asset.relatedOriginalPath)) {
    const originalPath = optimized.relatedOriginalPath!;
    const file = resolveOriginal(originalPath);
    if (!file) continue;
    const existing = assets.find(asset => asset.source === "original" && asset.filePath === originalPath);
    if (existing) {
      if (existing.relatedOptimizedPath !== optimized.filePath) {
        existing.relatedOptimizedPath = optimized.filePath;
        changed = true;
      }
      continue;
    }
    const optimizedIndex = assets.indexOf(optimized);
    assets.splice(optimizedIndex + 1, 0, {
      id: createId(),
      filePath: originalPath,
      name: file.name,
      mimeType: file.mimeType ?? "image/gif",
      source: "original",
      createdAt: optimized.createdAt,
      relatedOptimizedPath: optimized.filePath,
      writeCredits: 0,
    });
    changed = true;
  }
  return changed;
}

export function canRegenerateImage<T extends Pick<ImageAsset, "source" | "prompt">>(
  asset: T,
): asset is T & { source: "generated"; prompt: string } {
  return asset.source === "generated" && Boolean(asset.prompt?.trim());
}

export interface NoteState {
  messages: ChatMessage[];
  assets: ImageAsset[];
  codexThreadId?: string;
  agentSessions?: Partial<Record<ChatAgentId, string>>;
  archivedConversations?: ArchivedConversation[];
  activeSkillPath?: string;
  renderSkillPath?: string;
  previewMode?: "live" | "skill";
  skillRender?: SkillRenderResult;
  themeId?: string;
  writingStyleEnabled?: boolean;
}

export interface AgentSettings {
  activeChatAgent: ChatAgentId;
  codexPath: string;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  codexWebSearchEnabled: boolean;
  claudePath: string;
  claudeModel: string;
  workbuddyPath: string;
  workbuddyModel: string;
  topicAnalysisAgent: ChatAgentId;
  topicAnalysisModel: string;
  maxContextChars: number;
  imageModel: string;
  imageSize: ImageSize;
  hasImageApiKey: boolean;
  syncRoute: SyncRoute;
  relayUrl: string;
  defaultWeChatAuthor: string;
  hasRelayKey: boolean;
  cloudUrl: string;
  hasCloudToken: boolean;
  cloudConnectionId: string;
  cloudAccountName: string;
  cloudAccountId: string;
}

export interface PersistedData {
  version: 6;
  settings: AgentSettings;
  notes: Record<string, NoteState>;
  topics: TopicIdea[];
  feedbackMemory?: ChatFeedbackMemoryEntry[];
  wechatImageCache?: Record<string, WeChatImageCacheEntry>;
  relayAccountBindings?: Record<string, RelayAccountBinding>;
  writingStyleProfile?: WritingStyleProfile;
  topicPositioningProfile?: TopicPositioningProfile;
  discoveredAgentModels?: Partial<Record<ChatAgentId, DiscoveredAgentModels>>;
}

export interface WeChatImageCacheEntry {
  sourceSha256: string;
  uploadSha256: string;
  url: string;
  accountId: string;
  relayUrl: string;
  cachedAt: number;
}

export interface RelayAccountBinding {
  accountId: string;
  accountName: string;
  relayUrl: string;
  verifiedAt: number;
}

export const DEFAULT_SETTINGS: AgentSettings = {
  activeChatAgent: "codex",
  codexPath: "",
  codexModel: "",
  codexReasoningEffort: "",
  codexWebSearchEnabled: false,
  claudePath: "",
  claudeModel: "",
  workbuddyPath: "",
  workbuddyModel: "",
  topicAnalysisAgent: "codex",
  topicAnalysisModel: "",
  maxContextChars: 30000,
  imageModel: "gpt-image-2",
  imageSize: "1536x1024",
  hasImageApiKey: false,
  syncRoute: "self-hosted",
  relayUrl: "",
  defaultWeChatAuthor: "",
  hasRelayKey: false,
  cloudUrl: "https://cloud.write.pakcochan.com",
  hasCloudToken: false,
  cloudConnectionId: "",
  cloudAccountName: "",
  cloudAccountId: "",
};

export function migrateSettings(value: Partial<AgentSettings> | null | undefined): AgentSettings {
  const settings = { ...DEFAULT_SETTINGS, ...(value ?? {}) };
  if (!["codex", "claude", "workbuddy"].includes(settings.activeChatAgent)) settings.activeChatAgent = "codex";
  if (typeof settings.codexModel !== "string") settings.codexModel = "";
  if (typeof settings.claudeModel !== "string") settings.claudeModel = "";
  if (typeof settings.workbuddyModel !== "string") settings.workbuddyModel = "";
  if (!["codex", "claude", "workbuddy"].includes(settings.topicAnalysisAgent)) settings.topicAnalysisAgent = "codex";
  if (typeof settings.topicAnalysisModel !== "string") settings.topicAnalysisModel = "";
  if (!["", "low", "medium", "high", "xhigh", "max", "ultra"].includes(settings.codexReasoningEffort)) settings.codexReasoningEffort = "";
  if (typeof settings.codexWebSearchEnabled !== "boolean") settings.codexWebSearchEnabled = false;
  if (!["1024x1024", "1536x1024", "1024x1536"].includes(settings.imageSize)) settings.imageSize = DEFAULT_SETTINGS.imageSize;
  if (!["self-hosted", "write-cloud"].includes(settings.syncRoute)) settings.syncRoute = "self-hosted";
  if (typeof settings.cloudUrl !== "string" || !settings.cloudUrl.trim()) settings.cloudUrl = DEFAULT_SETTINGS.cloudUrl;
  return settings;
}

export function moveNoteStatePath(
  notes: Record<string, NoteState>,
  oldPath: string,
  newPath: string,
): boolean {
  if (!oldPath || !newPath || oldPath === newPath || !notes[oldPath] || notes[newPath]) return false;
  notes[newPath] = notes[oldPath];
  delete notes[oldPath];
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function migrateWritingStyleProfile(value: unknown): WritingStyleProfile | undefined {
  if (!isRecord(value) || typeof value.markdown !== "string" || !value.markdown.trim()) return undefined;
  const sources = Array.isArray(value.sources) ? value.sources.filter(isRecord).flatMap(source => {
    if ((source.kind !== "note" && source.kind !== "selection") || typeof source.sourceHash !== "string") return [];
    return [{
      kind: source.kind,
      ...(typeof source.filePath === "string" && source.filePath ? { filePath: source.filePath } : {}),
      sourceHash: source.sourceHash,
      capturedAt: typeof source.capturedAt === "number" ? source.capturedAt : 0,
      characterCount: typeof source.characterCount === "number" ? source.characterCount : 0,
      includedChars: typeof source.includedChars === "number" ? source.includedChars : 0,
    } satisfies WritingStyleSourceRef];
  }) : [];
  const agent: ChatAgentId = value.agent === "claude" || value.agent === "workbuddy" ? value.agent : "codex";
  const lastSkillExport = isRecord(value.lastSkillExport) && typeof value.lastSkillExport.path === "string" && typeof value.lastSkillExport.contentHash === "string"
    ? { path: value.lastSkillExport.path, contentHash: value.lastSkillExport.contentHash, exportedAt: typeof value.lastSkillExport.exportedAt === "number" ? value.lastSkillExport.exportedAt : 0 }
    : undefined;
  return {
    markdown: value.markdown,
    sources,
    revision: typeof value.revision === "number" && value.revision > 0 ? Math.floor(value.revision) : 1,
    agent,
    model: typeof value.model === "string" ? value.model : "默认",
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    ...(lastSkillExport ? { lastSkillExport } : {}),
  };
}

function migrateTopicRating(value: unknown): TopicRating | undefined {
  if (!isRecord(value)
    || typeof value.stars !== "number" || !Number.isInteger(value.stars) || value.stars < 1 || value.stars > 5
    || typeof value.detail !== "string" || !value.detail.trim()
    || !["codex", "claude", "workbuddy"].includes(value.agent as string)
    || typeof value.model !== "string"
    || typeof value.profileHash !== "string" || !value.profileHash.trim()
    || typeof value.analyzedAt !== "number" || !Number.isFinite(value.analyzedAt)) return undefined;
  return {
    stars: value.stars as TopicRating["stars"],
    detail: value.detail.trim(),
    ...(typeof value.suggestion === "string" && value.suggestion.trim() ? { suggestion: value.suggestion.trim() } : {}),
    agent: value.agent as ChatAgentId,
    model: value.model,
    profileHash: value.profileHash,
    analyzedAt: value.analyzedAt,
  };
}

function migrateTopicDecision(value: unknown): TopicDecision | undefined {
  if (!isRecord(value)
    || !["adopt", "defer", "dismiss"].includes(value.value as string)
    || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;
  return {
    value: value.value as TopicDecisionValue,
    ...(typeof value.reason === "string" && value.reason.trim() ? { reason: value.reason.trim() } : {}),
    ...(typeof value.correction === "string" && value.correction.trim() ? { correction: value.correction.trim() } : {}),
    updatedAt: value.updatedAt,
  };
}

function migrateTopic(value: Record<string, unknown>): TopicIdea {
  const { rating: rawRating, decision: rawDecision, ratingStale: rawRatingStale, ...legacy } = value;
  const rating = migrateTopicRating(rawRating);
  const decision = migrateTopicDecision(rawDecision);
  return {
    ...legacy,
    sourceKind: value.sourceKind === "manual" ? "manual" : "chat",
    ...(rating ? { rating, ...(typeof rawRatingStale === "boolean" ? { ratingStale: rawRatingStale } : {}) } : {}),
    ...(decision ? { decision } : {}),
  } as unknown as TopicIdea;
}

export function migratePersistedData(value: unknown): PersistedData {
  const source = isRecord(value) ? structuredClone(value) : {};
  delete source.writingStyleProfile;
  const rawWritingStyleProfile = isRecord(value) ? value.writingStyleProfile : undefined;
  const rawNotes = isRecord(source.notes) ? source.notes : {};
  const notes: Record<string, NoteState> = {};
  for (const [path, rawNote] of Object.entries(rawNotes)) {
    const note = isRecord(rawNote) ? rawNote : {};
    const { writingStyleEnabled: rawWritingStyleEnabled, ...noteWithoutWritingStyleEnabled } = note;
    const legacyRender = isRecord(note.skillRender) ? note.skillRender : undefined;
    const inferredTheme = typeof note.themeId === "string" && note.themeId.trim()
      ? note.themeId
      : typeof legacyRender?.themeId === "string" && legacyRender.themeId.trim()
        ? legacyRender.themeId
        : "default";
    notes[path] = {
      ...noteWithoutWritingStyleEnabled,
      messages: Array.isArray(note.messages) ? note.messages as ChatMessage[] : [],
      assets: Array.isArray(note.assets) ? note.assets as ImageAsset[] : [],
      themeId: inferredTheme,
      ...(typeof rawWritingStyleEnabled === "boolean" ? { writingStyleEnabled: rawWritingStyleEnabled } : {}),
    } as NoteState;
  }
  const topics = Array.isArray(source.topics)
    ? source.topics.filter(isRecord).map(migrateTopic)
    : [];
  const writingStyleProfile = migrateWritingStyleProfile(rawWritingStyleProfile);
  const rawPositioning = isRecord(value) ? value.topicPositioningProfile : undefined;
  const topicPositioningProfile = isRecord(rawPositioning) && typeof rawPositioning.path === "string" && rawPositioning.path.trim() && typeof rawPositioning.contentHash === "string"
    ? { path: rawPositioning.path, contentHash: rawPositioning.contentHash, updatedAt: typeof rawPositioning.updatedAt === "number" ? rawPositioning.updatedAt : 0 }
    : undefined;
  const rawCatalog = isRecord(value) && isRecord(value.discoveredAgentModels) ? value.discoveredAgentModels : {};
  const discoveredAgentModels = Object.fromEntries(["codex", "claude", "workbuddy"].flatMap(agent => {
    const entry = rawCatalog[agent];
    if (!isRecord(entry) || !Array.isArray(entry.models)) return [];
    const models = entry.models.filter(isRecord).flatMap(model => typeof model.value === "string" && model.value.trim()
      ? [{ value: model.value.trim(), label: typeof model.label === "string" && model.label.trim() ? model.label.trim() : model.value.trim() }]
      : []);
    return [[agent, { fetchedAt: typeof entry.fetchedAt === "number" ? entry.fetchedAt : 0, models }]];
  })) as Partial<Record<ChatAgentId, DiscoveredAgentModels>>;
  return {
    ...source,
    version: 6,
    settings: migrateSettings(isRecord(source.settings) ? source.settings as Partial<AgentSettings> : undefined),
    notes,
    topics,
    feedbackMemory: Array.isArray(source.feedbackMemory) ? source.feedbackMemory as ChatFeedbackMemoryEntry[] : [],
    wechatImageCache: isRecord(source.wechatImageCache) ? source.wechatImageCache as Record<string, WeChatImageCacheEntry> : {},
    relayAccountBindings: isRecord(source.relayAccountBindings) ? source.relayAccountBindings as Record<string, RelayAccountBinding> : {},
    ...(writingStyleProfile ? { writingStyleProfile } : {}),
    ...(topicPositioningProfile ? { topicPositioningProfile } : {}),
    ...(Object.keys(discoveredAgentModels).length ? { discoveredAgentModels } : {}),
  };
}

export function emptyNoteState(): NoteState {
  return { messages: [], assets: [], themeId: "default" };
}
