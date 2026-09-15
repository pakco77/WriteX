export async function loadPreviewIfCurrent(input: {
  notePath: string;
  generation: number;
  isCurrent: (notePath: string, generation: number) => boolean;
  read: (notePath: string) => Promise<string>;
  commit: (markdown: string) => void;
}): Promise<boolean> {
  const markdown = await input.read(input.notePath);
  if (!input.isCurrent(input.notePath, input.generation)) return false;
  input.commit(markdown);
  return true;
}
