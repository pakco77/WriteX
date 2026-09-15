export interface QuickTopicInput {
  value: string;
  disabled: boolean;
  focus(): void;
}

export function shouldSaveQuickTopicOnKey(key: string, isComposing: boolean): boolean {
  return key === "Enter" && !isComposing;
}

export function searchDraftForTopicActivation(searchDraft: string, focusedTopicId?: string): string {
  return focusedTopicId ? "" : searchDraft;
}

export function shouldScrollFocusedTopic(topicId: string, focusedTopicId: string): boolean {
  return Boolean(focusedTopicId) && topicId === focusedTopicId;
}

export function topicArticleFileName(title: string): string {
  const safe = title
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/-+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  return `${safe || "未命名文章"}.md`;
}

export async function saveQuickTopicInput(input: {
  input: QuickTopicInput;
  currentDraft: () => string;
  save: (value: string) => Promise<void>;
  clearDraft: () => void;
  refreshCards: () => void;
  reportError: (error: unknown) => void;
  setSaving: (value: boolean) => void;
}): Promise<boolean> {
  input.setSaving(true);
  input.input.disabled = true;
  try {
    await input.save(input.currentDraft());
    input.clearDraft();
    input.setSaving(false);
    input.input.value = "";
    input.input.disabled = false;
    input.refreshCards();
    input.input.focus();
    return true;
  } catch (error) {
    input.setSaving(false);
    input.input.value = input.currentDraft();
    input.input.disabled = false;
    input.input.focus();
    input.reportError(error);
    return false;
  }
}
