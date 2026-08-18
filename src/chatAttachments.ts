export const CHAT_ATTACHMENT_MAX_COUNT = 10;
export const CHAT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const CHAT_ATTACHMENT_TOTAL_MAX_BYTES = 50 * 1024 * 1024;

export interface ChatAttachmentInput {
  name: string;
  size: number;
  type: string;
}

export function validateChatAttachmentInputs(inputs: readonly ChatAttachmentInput[]): string | undefined {
  if (inputs.length > CHAT_ATTACHMENT_MAX_COUNT) return `一次最多添加 ${CHAT_ATTACHMENT_MAX_COUNT} 个附件。`;
  let total = 0;
  for (const input of inputs) {
    if (!Number.isFinite(input.size) || input.size <= 0) return `“${input.name || "未命名附件"}”是空文件，不能作为上下文发送。`;
    if (input.size > CHAT_ATTACHMENT_MAX_BYTES) return `“${input.name || "未命名附件"}”超过单文件 20 MB 限制。`;
    total += input.size;
  }
  if (total > CHAT_ATTACHMENT_TOTAL_MAX_BYTES) return "本次附件总大小超过 50 MB 限制。";
  return undefined;
}
