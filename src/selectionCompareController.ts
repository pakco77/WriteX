import { buildBoundedTextDiff, type DiffPart } from "./selectionDiff.ts";

export interface SelectionComparison {
  parts: DiffPart[];
  truncated: boolean;
}

/** Keeps comparison rendering side-effect free; only the explicit apply action can write. */
export function prepareSelectionComparison(original: string, suggestion: string, budget?: number): SelectionComparison {
  return buildBoundedTextDiff(original, suggestion, budget);
}

export class SelectionCompareController {
  private consumed = false;
  private readonly replace: () => Promise<void>;
  private readonly close: () => void;

  constructor(replace: () => Promise<void>, close: () => void) {
    this.replace = replace;
    this.close = close;
  }

  keepOriginal(): void { this.close(); }

  async applyOnce(): Promise<boolean> {
    if (this.consumed) return false;
    this.consumed = true;
    try {
      await this.replace();
      this.close();
      return true;
    } catch (error) {
      this.close();
      throw new Error(`${error instanceof Error ? error.message : String(error)}；替换结果可能不确定，请核对正文后重新划词。`);
    }
  }
}
