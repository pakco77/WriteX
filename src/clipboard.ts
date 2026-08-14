export interface ClipboardWriters {
  electronWriteText?: (value: string) => void;
  browserWriteText?: (value: string) => Promise<void>;
}

export async function writeClipboardText(value: string, writers: ClipboardWriters): Promise<void> {
  let desktopError: unknown;
  if (writers.electronWriteText) {
    try {
      writers.electronWriteText(value);
      return;
    } catch (error) {
      desktopError = error;
    }
  }
  if (writers.browserWriteText) {
    await writers.browserWriteText(value);
    return;
  }
  if (desktopError instanceof Error) throw desktopError;
  throw new Error("当前环境没有可用的文本剪贴板。");
}
