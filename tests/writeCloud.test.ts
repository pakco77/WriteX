import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudError,
  WriteCloudClient,
  normalizeCloudUrl,
  type CloudTransportRequest,
} from "../src/writeCloud.ts";

test("Write Cloud URL follows the same HTTPS boundary as self-hosted Relay", () => {
  assert.equal(normalizeCloudUrl("https://cloud.writex.example/"), "https://cloud.writex.example");
  assert.equal(normalizeCloudUrl("http://localhost:8788/"), "http://localhost:8788");
  assert.throws(() => normalizeCloudUrl("http://cloud.writex.example"), /HTTPS/);
  assert.throws(() => normalizeCloudUrl("https://user:secret@example.com"), /凭据/);
});

test("trial start and test-credit profile never put secrets in URLs", async () => {
  const requests: CloudTransportRequest[] = [];
  const client = new WriteCloudClient("https://cloud.writex.example", "", async request => {
    requests.push(request);
    if (request.url.endsWith("/v1/auth/trial")) return {
      status: 201,
      json: { ok: true, userId: "usr-1", accessToken: "device-token", expiresAt: "2026-09-13T00:00:00Z", created: true, credits: 0, creditKind: "test", purchasable: false },
    };
    return { status: 200, json: { ok: true, id: "usr-1", displayName: "测试者", credits: 8, creditKind: "test", purchasable: false } };
  });
  const session = await client.startTrial("installation-secret");
  assert.equal(session.accessToken, "device-token");
  const profile = await new WriteCloudClient("https://cloud.writex.example", session.accessToken, client.transport).profile();
  assert.equal(profile.credits, 8);
  assert.equal(profile.purchasable, false);
  assert.equal(requests.some(request => request.url.includes("installation-secret") || request.url.includes("device-token")), false);
  assert.match(String(requests[0]?.body), /installation-secret/);
  assert.equal(requests[1]?.headers?.Authorization, "Bearer device-token");
});

test("verified connection exposes whether eight trial credits were granted", async () => {
  const client = new WriteCloudClient("https://cloud.writex.example", "device-token", async () => ({
    status: 200,
    json: {
      ok: true, id: "con-1", accountName: "测试公众号", accountId: "account-1", status: "verified",
      verifiedAt: "2026-08-14T00:00:00Z", trialGranted: true, grantedCredits: 8, balance: 8,
    },
  }));
  const connection = await client.verifyConnection("con-1");
  assert.equal(connection.trialGranted, true);
  assert.equal(connection.grantedCredits, 8);
  assert.equal(connection.balance, 8);
});

test("confirmed cloud job implements the existing SyncRelay contract and exposes a receipt", async () => {
  const requests: CloudTransportRequest[] = [];
  const client = new WriteCloudClient("https://cloud.writex.example", "device-token", async request => {
    requests.push(request);
    if (request.url.endsWith("/v1/quotes")) return { status: 201, json: {
      ok: true, id: "quo-1", connectionId: "con-1", action: "创建微信公众号草稿",
      contentHash: "a".repeat(64), imageCount: 1, credits: 1, balance: 5,
      testCredits: true, purchasable: false, expiresAt: "2026-08-13T08:10:00Z",
    } };
    if (request.url.endsWith("/v1/jobs")) return { status: 201, json: {
      ok: true, id: "job-1", status: "reserved", operation: "create", reservedCredits: 1, availableCredits: 4,
    } };
    if (request.url.includes("/assets?kind=content")) return { status: 200, json: { ok: true, url: "https://mmbiz.qpic.cn/test", cached: false } };
    return { status: 200, json: {
      ok: true, jobId: "job-1", draftId: "draft-1", operation: "created",
      imageCount: 1, credits: 1, balance: 4, completedAt: "2026-08-13T08:01:00Z",
    } };
  });
  const quote = await client.createQuote("con-1", "create", "a".repeat(64), 1);
  const job = await client.beginJob(quote.id, "job-key", "b".repeat(64));
  assert.equal(job.reservedCredits, 1);
  const image = await client.uploadAsset({
    kind: "content", fileName: "图.jpg", mimeType: "image/jpeg", sha256: "c".repeat(64),
    idempotencyKey: "asset-key", bytes: new ArrayBuffer(3),
  });
  assert.equal(image.url, "https://mmbiz.qpic.cn/test");
  const draft = await client.createDraft({
    title: "测试", author: "", digest: "", content: "<p>正文</p>", contentHash: "a".repeat(64),
    coverMediaId: "cover-1", commentsEnabled: false, onlyFansCanComment: false,
  }, "draft-key");
  assert.equal(draft.draftId, "draft-1");
  assert.equal(client.receipt?.balance, 4);
  assert.equal(requests.filter(request => request.url.includes("/drafts")).length, 1);
});

test("cloud errors redact the access token", async () => {
  const token = "private-device-token";
  const client = new WriteCloudClient("https://cloud.writex.example", token, async () => ({
    status: 409, json: { ok: false, error: { code: "insufficient_test_credits", message: `bad ${token}` } },
  }));
  await assert.rejects(() => client.profile(), error => (
    error instanceof CloudError
    && error.code === "insufficient_test_credits"
    && !error.message.includes(token)
  ));
});

test("a confirmed job can be explicitly cancelled without adding a payment path", async () => {
  let request: CloudTransportRequest | undefined;
  const client = new WriteCloudClient("https://cloud.writex.example", "token", async value => {
    request = value;
    return { status: 200, json: { ok: true, id: "job-1", status: "cancelled", releasedCredits: 1 } };
  });
  await client.cancelJob("job-1");
  assert.equal(request?.method, "POST");
  assert.match(request?.url ?? "", /\/v1\/jobs\/job-1\/cancel$/);
});

test("cloud credential lifecycle uses explicit destructive endpoints and never sends the token in a URL", async () => {
  const requests: CloudTransportRequest[] = [];
  const client = new WriteCloudClient("https://cloud.writex.example", "device-token", async request => {
    requests.push(request);
    return { status: 200, json: { ok: true, connectionId: "con-1", erasedSecret: true, revokedSessions: 1, revokedInstallations: 1 } };
  });
  await client.deleteConnection("con-1");
  await client.revokeCurrentInstallation("installation-token");
  assert.deepEqual(requests.map(request => request.method), ["DELETE", "DELETE"]);
  assert.match(requests[0]?.url ?? "", /\/v1\/connections\/con-1$/);
  assert.match(requests[1]?.url ?? "", /\/v1\/me\/installations\/current$/);
  assert.equal(requests.some(request => request.url.includes("device-token")), false);
  assert.equal(requests.every(request => request.headers?.Authorization === "Bearer device-token"), true);
});
