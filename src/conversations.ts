import type { ArchivedConversation, ChatAgentId, NoteState } from "./types.ts";

export function getAgentSession(state: NoteState, agent: ChatAgentId): string | undefined {
  return state.agentSessions?.[agent] ?? (agent === "codex" ? state.codexThreadId : undefined);
}

export function setAgentSession(state: NoteState, agent: ChatAgentId, sessionId?: string): void {
  if (sessionId) {
    state.agentSessions ??= {};
    state.agentSessions[agent] = sessionId;
  } else if (state.agentSessions) {
    delete state.agentSessions[agent];
    if (!Object.keys(state.agentSessions).length) delete state.agentSessions;
  }
  if (agent === "codex") {
    if (sessionId) state.codexThreadId = sessionId;
    else delete state.codexThreadId;
  }
}

function currentAgentSessions(state: NoteState): Partial<Record<ChatAgentId, string>> | undefined {
  const sessions = { ...(state.agentSessions ?? {}) };
  if (state.codexThreadId && !sessions.codex) sessions.codex = state.codexThreadId;
  return Object.keys(sessions).length ? sessions : undefined;
}

function conversationTitle(messages: NoteState["messages"]): string {
  const first = messages.find(message => message.role === "user" && message.content.trim()) ?? messages[0];
  return first?.content.replace(/\s+/g, " ").trim().slice(0, 42) || "未命名对话";
}

export function archiveActiveConversation(state: NoteState, createId: () => string): boolean {
  if (!state.messages.length) return false;
  const archived: ArchivedConversation = {
    id: createId(),
    title: conversationTitle(state.messages),
    createdAt: state.messages[0]?.createdAt ?? Date.now(),
    updatedAt: state.messages.at(-1)?.createdAt ?? Date.now(),
    messages: state.messages,
    codexThreadId: state.codexThreadId,
    agentSessions: currentAgentSessions(state),
  };
  state.archivedConversations ??= [];
  state.archivedConversations.push(archived);
  state.messages = [];
  delete state.codexThreadId;
  delete state.agentSessions;
  return true;
}

export function restoreArchivedConversation(
  state: NoteState,
  conversationId: string,
  createId: () => string,
): boolean {
  const index = state.archivedConversations?.findIndex(conversation => conversation.id === conversationId) ?? -1;
  if (index < 0 || !state.archivedConversations) return false;
  const selected = state.archivedConversations[index];
  archiveActiveConversation(state, createId);
  const currentIndex = state.archivedConversations.findIndex(conversation => conversation.id === conversationId);
  if (currentIndex < 0) return false;
  state.archivedConversations.splice(currentIndex, 1);
  state.messages = selected.messages;
  state.agentSessions = selected.agentSessions ? { ...selected.agentSessions } : undefined;
  const codexSession = selected.agentSessions?.codex ?? selected.codexThreadId;
  if (codexSession) setAgentSession(state, "codex", codexSession);
  else delete state.codexThreadId;
  return true;
}
