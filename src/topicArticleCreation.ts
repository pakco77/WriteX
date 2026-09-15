export class CreatedTopicArticleUnlinkedError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(`文章已创建在 ${filePath}，但关联未保存；请用“关联已有文章”选择它。${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.filePath = filePath;
  }
}

/** Creates at most once; a retry associates the recoverable file instead of creating a suffix. */
export async function createOrAssociateTopicArticle<File>(input: {
  linkedPath?: string;
  pendingPath?: string;
  fileAtPath: (path: string) => File | null;
  nextPath: () => string;
  create: (path: string) => Promise<File>;
  pathOf: (file: File) => string;
  associate: (file: File) => Promise<void>;
}): Promise<File> {
  const known = input.linkedPath || input.pendingPath;
  const existing = known ? input.fileAtPath(known) : null;
  if (existing) {
    await input.associate(existing);
    return existing;
  }
  const file = await input.create(input.nextPath());
  try {
    await input.associate(file);
    return file;
  } catch (error) {
    throw new CreatedTopicArticleUnlinkedError(input.pathOf(file), error);
  }
}
