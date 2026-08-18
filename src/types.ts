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
  skill?: ChatSkillSnapshot;
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

export interface TopicIdea {
  id: string;
  title: string;
  content: string;
  sourceKind: TopicSourceKind;
  sourceNotePath?: string;
  sourceMessageId?: string;
  sourceAgent?: ChatAgentId;
  sourceModel?: string;
  createdAt: number;
  updatedAt: number;
  status?: TopicStatus;
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
}

export interface AgentSettings {
  activeChatAgent: ChatAgentId;
  codexPath: string;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  claudePath: string;
  claudeModel: string;
  workbuddyPath: string;
  workbuddyModel: string;
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
  version: 5;
  settings: AgentSettings;
  notes: Record<string, NoteState>;
  topics: TopicIdea[];
  feedbackMemory?: ChatFeedbackMemoryEntry[];
  wechatImageCache?: Record<string, WeChatImageCacheEntry>;
  relayAccountBindings?: Record<string, RelayAccountBinding>;
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
  claudePath: "",
  claudeModel: "",
  workbuddyPath: "",
  workbuddyModel: "",
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
  if (!["", "gpt-5.6-sol", "gpt-5.6-terra"].includes(settings.codexModel)) settings.codexModel = "";
  if (!["", "low", "medium", "high", "xhigh", "max", "ultra"].includes(settings.codexReasoningEffort)) settings.codexReasoningEffort = "";
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

export function migratePersistedData(value: unknown): PersistedData {
  const source = isRecord(value) ? structuredClone(value) : {};
  const rawNotes = isRecord(source.notes) ? source.notes : {};
  const notes: Record<string, NoteState> = {};
  for (const [path, rawNote] of Object.entries(rawNotes)) {
    const note = isRecord(rawNote) ? rawNote : {};
    const legacyRender = isRecord(note.skillRender) ? note.skillRender : undefined;
    const inferredTheme = typeof note.themeId === "string" && note.themeId.trim()
      ? note.themeId
      : typeof legacyRender?.themeId === "string" && legacyRender.themeId.trim()
        ? legacyRender.themeId
        : "default";
    notes[path] = {
      ...note,
      messages: Array.isArray(note.messages) ? note.messages as ChatMessage[] : [],
      assets: Array.isArray(note.assets) ? note.assets as ImageAsset[] : [],
      themeId: inferredTheme,
    } as NoteState;
  }
  const topics = Array.isArray(source.topics)
    ? source.topics.filter(isRecord).map(topic => ({
      ...topic,
      sourceKind: topic.sourceKind === "manual" ? "manual" : "chat",
    })) as unknown as TopicIdea[]
    : [];
  return {
    ...source,
    version: 5,
    settings: migrateSettings(isRecord(source.settings) ? source.settings as Partial<AgentSettings> : undefined),
    notes,
    topics,
    feedbackMemory: Array.isArray(source.feedbackMemory) ? source.feedbackMemory as ChatFeedbackMemoryEntry[] : [],
    wechatImageCache: isRecord(source.wechatImageCache) ? source.wechatImageCache as Record<string, WeChatImageCacheEntry> : {},
    relayAccountBindings: isRecord(source.relayAccountBindings) ? source.relayAccountBindings as Record<string, RelayAccountBinding> : {},
  };
}

export function emptyNoteState(): NoteState {
  return { messages: [], assets: [], themeId: "default" };
}
