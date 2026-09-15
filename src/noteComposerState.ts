export interface NoteComposerState<Attachment> {
  draft: string;
  attachments: Attachment[];
  chatMode: "chat" | "plan";
  outlineSession: boolean;
}

/** In-memory only: unsent text follows its note without changing Obsidian's article body. */
export class NoteComposerStates<Attachment> {
  private readonly states = new Map<string, NoteComposerState<Attachment>>();

  save(notePath: string, state: NoteComposerState<Attachment>): void {
    if (!notePath) return;
    if (!state.draft && !state.attachments.length && state.chatMode === "chat" && !state.outlineSession) {
      this.states.delete(notePath);
      return;
    }
    this.states.set(notePath, { ...state, attachments: [...state.attachments] });
  }

  load(notePath: string): NoteComposerState<Attachment> {
    const value = this.states.get(notePath);
    return value ? { ...value, attachments: [...value.attachments] } : {
      draft: "", attachments: [], chatMode: "chat", outlineSession: false,
    };
  }

  rename(oldPath: string, newPath: string): void {
    const state = this.states.get(oldPath);
    if (!state || oldPath === newPath) return;
    this.states.delete(oldPath);
    this.states.set(newPath, state);
  }

  /** Clears only the input this request captured, never text entered while it awaited I/O. */
  removeIfMatch(notePath: string, expected: NoteComposerState<Attachment>): boolean {
    const current = this.states.get(notePath);
    if (!current || !sameComposerState(current, expected)) return false;
    this.save(notePath, { ...current, draft: "", attachments: [] });
    return true;
  }

  clear(): void { this.states.clear(); }
}

function sameComposerState<Attachment>(left: NoteComposerState<Attachment>, right: NoteComposerState<Attachment>): boolean {
  return left.draft === right.draft
    && left.chatMode === right.chatMode
    && left.outlineSession === right.outlineSession
    && left.attachments.length === right.attachments.length
    && left.attachments.every((attachment, index) => attachment === right.attachments[index]);
}

/** Commits one captured request without letting a note round-trip erase later composer input. */
export function consumeCommittedComposerRequest<Attachment>(input: {
  states: NoteComposerStates<Attachment>;
  requestNotePath: string;
  request: NoteComposerState<Attachment>;
  active: { notePath: string; state: NoteComposerState<Attachment> };
}): boolean {
  const clearedStash = input.states.removeIfMatch(input.requestNotePath, input.request);
  return clearedStash && input.active.notePath === input.requestNotePath && sameComposerState(input.active.state, input.request);
}
