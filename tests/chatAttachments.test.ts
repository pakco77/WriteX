import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_TOTAL_MAX_BYTES,
  validateChatAttachmentInputs,
} from "../src/chatAttachments.ts";

test("Chat attachment limits reject empty, oversized, excessive, and over-budget input before Vault writes", () => {
  assert.equal(validateChatAttachmentInputs([{ name: "采访.md", size: 42, type: "text/markdown" }]), undefined);
  assert.match(
    validateChatAttachmentInputs([{ name: "空文件.txt", size: 0, type: "text/plain" }]) ?? "",
    /空文件/,
  );
  assert.match(
    validateChatAttachmentInputs([{ name: "过大.pdf", size: CHAT_ATTACHMENT_MAX_BYTES + 1, type: "application/pdf" }]) ?? "",
    /20 MB/,
  );
  assert.match(
    validateChatAttachmentInputs(Array.from({ length: CHAT_ATTACHMENT_MAX_COUNT + 1 }, (_, index) => ({
      name: `素材-${index}.txt`, size: 1, type: "text/plain",
    }))) ?? "",
    /最多/,
  );
  assert.match(
    validateChatAttachmentInputs([
      { name: "一.pdf", size: 17 * 1024 * 1024, type: "application/pdf" },
      { name: "二.pdf", size: 17 * 1024 * 1024, type: "application/pdf" },
      { name: "三.pdf", size: 17 * 1024 * 1024, type: "application/pdf" },
    ]) ?? "",
    /总大小/,
  );
});
