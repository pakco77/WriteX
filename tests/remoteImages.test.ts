import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  localizedRemoteImageName,
  replaceRemoteMarkdownImages,
} from "../src/remoteImages.ts";

test("remote image localization replaces only Markdown image destinations", () => {
  const remote = "https://mmbiz.qpic.cn/a/640?wx_fmt=jpeg&wxfrom=5#imgIndex=0";
  const markdown = [
    `原图地址：${remote}`,
    `[查看原图](${remote})`,
    `![办公室里的四种 AI 人](${remote})`,
    `再次出现：![](${remote})`,
  ].join("\n\n");

  const result = replaceRemoteMarkdownImages(markdown, new Map([
    [remote, "PakcoMind/writex-remote-1234567890ab.jpg"],
  ]));

  assert.match(result, new RegExp(`原图地址：${remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(result, new RegExp(`\\[查看原图\\]\\(${remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  assert.match(result, /!\[办公室里的四种 AI 人\]\(PakcoMind\/writex-remote-1234567890ab\.jpg\)/);
  assert.match(result, /再次出现：!\[\]\(PakcoMind\/writex-remote-1234567890ab\.jpg\)/);
  assert.equal(result.match(/writex-remote-1234567890ab\.jpg/g)?.length, 2);
});

test("localized remote image names use signature MIME rather than the URL suffix", () => {
  assert.equal(
    localizedRemoteImageName(
      "https://example.com/misleading.gif?wx_fmt=webp",
      "image/jpeg",
      "1234567890abcdef",
      0,
    ),
    "writex-remote-1234567890ab.jpg",
  );
  assert.equal(
    localizedRemoteImageName("https://example.com/no-extension", "image/png", "abcdef0123456789", 11),
    "writex-remote-abcdef012345.png",
  );
});

test("sync UI visualizes the blocked image and offers one explicit localization action", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/sync.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /保存到 Vault 并继续/);
  assert.match(source, /localizeRemoteImages/);
  assert.match(source, /oa-sync-remote-preview/);
  assert.match(styles, /\.oa-sync-remote-preview/);
});
