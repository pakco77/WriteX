const IMAGE_DESTINATION = /(!\[[^\]]*\]\()([^)\n]+)(\))/g;

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/avif": "avif",
};

export function localizedRemoteImageName(
  _source: string,
  mimeType: string,
  sha256: string,
  _index: number,
): string {
  const extension = MIME_EXTENSIONS[mimeType];
  if (!extension) throw new Error(`不支持保存这种远程图片格式：${mimeType || "未知格式"}`);
  return `writex-remote-${sha256.slice(0, 12)}.${extension}`;
}

export function replaceRemoteMarkdownImages(
  markdown: string,
  replacements: ReadonlyMap<string, string>,
): string {
  return markdown.replace(IMAGE_DESTINATION, (match, opening: string, destination: string, closing: string) => {
    const source = destination.trim();
    const replacement = replacements.get(source);
    if (!replacement) return match;
    return `${opening}${replacement}${closing}`;
  });
}
