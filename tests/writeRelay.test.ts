import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProtocolId,
  encodeRelayFileName,
  normalizeRelayUrl,
  RelayError,
  WriteRelayClient,
  type DraftPayload,
  type RelayTransportRequest,
} from "../src/writeRelay.ts";

test("relay URL requires HTTPS except for explicit loopback hosts", () => {
  assert.equal(normalizeRelayUrl("https://write.example.com/"), "https://write.example.com");
  assert.equal(normalizeRelayUrl("http://localhost:8765/"), "http://localhost:8765");
  assert.equal(normalizeRelayUrl("http://127.0.0.1:8765/"), "http://127.0.0.1:8765");
  assert.equal(normalizeRelayUrl("http://[::1]:8765/"), "http://[::1]:8765");
  assert.throws(() => normalizeRelayUrl("http://write.example.com"), /HTTPS/);
  assert.throws(() => normalizeRelayUrl("https://user:pass@example.com"), /凭据/);
  assert.throws(() => normalizeRelayUrl("https://example.com?key=secret"), /查询参数/);
  assert.throws(() => normalizeRelayUrl("file:///tmp/relay"), /HTTPS/);
});

test("relay protocol IDs are bounded ASCII values", () => {
  assert.equal(assertProtocolId("draft-ABC_123.xyz"), "draft-ABC_123.xyz");
  assert.equal(assertProtocolId("a".repeat(128)), "a".repeat(128));
  assert.throws(() => assertProtocolId(""), /不能为空/);
  assert.throws(() => assertProtocolId("含中文"), /ASCII/);
  assert.throws(() => assertProtocolId("a".repeat(129)), /128/);
  assert.throws(() => assertProtocolId("a/b"), /ASCII/);
});

test("relay file names are percent encoded and bounded by decoded UTF-8 bytes", () => {
  assert.equal(encodeRelayFileName("公众号头图.png"), encodeURIComponent("公众号头图.png"));
  assert.throws(() => encodeRelayFileName(""), /不能为空/);
  assert.throws(() => encodeRelayFileName("bad\nname.png"), /控制字符/);
  assert.throws(() => encodeRelayFileName("图".repeat(61)), /180/);
});

test("health is public while verify uses the relay key only in a header", async () => {
  const requests: RelayTransportRequest[] = [];
  const client = new WriteRelayClient("https://relay.example.com", "relay-secret", async request => {
    requests.push(request);
    if (request.url.endsWith("/v1/health")) return { status: 200, json: { ok: true, protocolVersion: "v1" } };
    return { status: 200, json: { ok: true, protocolVersion: "v1", accountName: "测试号", accountId: "wx-test-account", verifiedAt: "2026-08-08T12:00:00+08:00" } };
  });

  await client.health();
  await client.verify();
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].headers?.["X-Write-Relay-Key"], undefined);
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].headers?.["X-Write-Relay-Key"], "relay-secret");
  assert.equal(requests[1].url.includes("relay-secret"), false);
});

test("asset upload uses bounded encoded headers and validates role-specific response", async () => {
  const requests: RelayTransportRequest[] = [];
  const client = new WriteRelayClient("https://relay.example.com", "secret", async request => {
    requests.push(request);
    if (request.url.endsWith("kind=content")) {
      return { status: 200, json: { ok: true, kind: "content", sha256: "a".repeat(64), url: "http://mmbiz.qpic.cn/a", cached: false } };
    }
    return { status: 200, json: { ok: true, kind: "cover", sha256: "b".repeat(64), mediaId: "cover-media", cached: true } };
  });

  const content = await client.uploadAsset({
    kind: "content",
    fileName: "公众号配图.jpg",
    mimeType: "image/jpeg",
    sha256: "a".repeat(64),
    idempotencyKey: "asset-content-" + "a".repeat(64),
    bytes: Uint8Array.from([0xff, 0xd8, 0xff]).buffer,
  });
  assert.equal(content.url, "http://mmbiz.qpic.cn/a");
  assert.equal(requests[0].headers?.["X-Write-File-Name"], encodeURIComponent("公众号配图.jpg"));
  assert.equal(requests[0].headers?.["X-Write-Relay-Key"], "secret");

  const cover = await client.uploadAsset({
    kind: "cover",
    fileName: "cover.png",
    mimeType: "image/png",
    sha256: "b".repeat(64),
    idempotencyKey: "asset-cover-" + "b".repeat(64),
    bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer,
  });
  assert.equal(cover.mediaId, "cover-media");
});

test("draft create and update use distinct methods and reject unresolved placeholders", async () => {
  const requests: RelayTransportRequest[] = [];
  const client = new WriteRelayClient("https://relay.example.com", "secret", async request => {
    requests.push(request);
    return {
      status: 200,
      json: { ok: true, draftId: "draft-123", operation: request.method === "POST" ? "created" : "updated", cached: false },
    };
  });
  const payload: DraftPayload = {
    title: "安全验收",
    author: "Write",
    digest: "摘要",
    content: "<p>正文</p>",
    contentHash: "c".repeat(64),
    coverMediaId: "cover-media",
    commentsEnabled: false,
    onlyFansCanComment: false,
  };

  await client.createDraft(payload, "draft-" + "c".repeat(64));
  await client.updateDraft("draft-123", payload, "draft-" + "d".repeat(64));
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url.endsWith("/v1/drafts"), true);
  assert.equal(requests[1].method, "PUT");
  assert.equal(requests[1].url.endsWith("/v1/drafts/draft-123"), true);
  await assert.rejects(() => client.createDraft({ ...payload, content: "https://write.invalid/assets/a" }, "draft-a"), /图片占位符/);
});

test("relay errors and malformed responses are safe and structured", async () => {
  const secret = "relay-secret-value";
  const denied = new WriteRelayClient("https://relay.example.com", secret, async () => ({
    status: 403,
    json: { ok: false, error: { code: "relay_auth_failed", message: "bad " + secret } },
  }));
  await assert.rejects(
    () => denied.verify(),
    error => error instanceof RelayError && error.code === "relay_auth_failed" && !error.message.includes(secret),
  );

  const malformed = new WriteRelayClient("https://relay.example.com", "secret", async () => ({ status: 200, json: { ok: true } }));
  await assert.rejects(() => malformed.verify(), /响应格式/);
});
