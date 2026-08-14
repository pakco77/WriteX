import type {
  AssetResult,
  AssetUploadInput,
  DraftPayload,
  DraftResult,
  RelayTransport,
  RelayTransportRequest,
  RelayTransportResult,
} from "./writeRelay.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PROTOCOL_ID = /^[A-Za-z0-9._-]{1,128}$/;

export type CloudTransportRequest = RelayTransportRequest;
export type CloudTransportResult = RelayTransportResult;
export type CloudTransport = RelayTransport;

export interface CloudSession {
  userId?: string;
  accessToken: string;
  expiresAt: string;
  created?: boolean;
  credits?: number;
  creditKind: "test";
  purchasable: false;
}

export interface CloudProfile {
  id: string;
  displayName: string;
  credits: number;
  creditKind: "test";
  purchasable: false;
}

export interface CloudConnection {
  id: string;
  accountName: string;
  accountId?: string;
  status: "pending" | "verified";
  verifiedAt?: string;
  trialGranted?: boolean;
  grantedCredits?: number;
  balance?: number;
}

export interface CloudQuote {
  id: string;
  connectionId: string;
  action: "创建微信公众号草稿" | "更新微信公众号草稿";
  contentHash: string;
  imageCount: number;
  credits: number;
  balance: number;
  testCredits: true;
  purchasable: false;
  expiresAt: string;
}

export interface CloudJob {
  id: string;
  status: "reserved";
  operation: "create" | "update";
  reservedCredits: number;
  availableCredits: number;
}

export interface CloudReceipt {
  jobId: string;
  draftId: string;
  operation: "created" | "updated";
  imageCount: number;
  credits: number;
  balance: number;
  completedAt: string;
}

export class CloudError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    message: string,
    code: string,
    status: number,
  ) {
    super(message);
    this.name = "CloudError";
    this.code = code;
    this.status = status;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !PROTOCOL_ID.test(value)) throw new Error(`${label} 响应格式无效。`);
  return value;
}

function sha256(value: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("内容哈希必须是 SHA-256。");
  return value.toLowerCase();
}

export function normalizeCloudUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("Write Cloud URL 不能为空。");
  const url = new URL(value);
  const local = LOOPBACK_HOSTS.has(url.hostname);
  if (!local && url.protocol !== "https:") throw new Error("非本机 Write Cloud 必须使用 HTTPS。");
  if (local && !["http:", "https:"].includes(url.protocol)) throw new Error("本机 Write Cloud 必须使用 HTTP 或 HTTPS。");
  if (url.username || url.password) throw new Error("Write Cloud URL 不得包含凭据。");
  if (url.search || url.hash) throw new Error("Write Cloud URL 不得包含查询参数或片段。");
  return url.toString().replace(/\/$/, "");
}

export class WriteCloudClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  readonly transport: CloudTransport;
  private activeJobId = "";
  receipt: CloudReceipt | null = null;

  constructor(
    baseUrl: string,
    accessToken: string,
    transport: CloudTransport,
  ) {
    this.baseUrl = normalizeCloudUrl(baseUrl);
    this.accessToken = accessToken.trim();
    this.transport = transport;
  }

  async health(): Promise<{ ok: true; protocolVersion: "cloud-v0.5a"; billing: "test-credits-only"; purchasable: false }> {
    const value = await this.send("GET", "/v1/health", false);
    if (value.ok !== true || value.protocolVersion !== "cloud-v0.5a" || value.billing !== "test-credits-only" || value.purchasable !== false) {
      throw new Error("Write Cloud 健康检查响应格式无效。");
    }
    return { ok: true, protocolVersion: "cloud-v0.5a", billing: "test-credits-only", purchasable: false };
  }

  async redeemInvite(inviteCode: string): Promise<CloudSession> {
    if (!inviteCode.trim()) throw new Error("邀请码不能为空。");
    const value = await this.send("POST", "/v1/auth/redeem", false, {
      "Content-Type": "application/json; charset=utf-8",
    }, JSON.stringify({ inviteCode: inviteCode.trim() }));
    if (
      typeof value.accessToken !== "string" || !value.accessToken
      || typeof value.expiresAt !== "string"
      || value.creditKind !== "test" || value.purchasable !== false
    ) throw new Error("Write Cloud 邀请登录响应格式无效。");
    return {
      accessToken: value.accessToken,
      expiresAt: value.expiresAt,
      creditKind: "test",
      purchasable: false,
    };
  }

  async startTrial(installationToken: string): Promise<CloudSession> {
    if (!installationToken.trim()) throw new Error("安装凭证不能为空。");
    const value = await this.send("POST", "/v1/auth/trial", false, {
      "Content-Type": "application/json; charset=utf-8",
    }, JSON.stringify({ installationToken: installationToken.trim() }));
    if (
      typeof value.accessToken !== "string" || !value.accessToken
      || typeof value.expiresAt !== "string" || typeof value.created !== "boolean"
      || !Number.isInteger(value.credits) || value.creditKind !== "test" || value.purchasable !== false
    ) throw new Error("Write Cloud 体验账户响应格式无效。");
    return {
      userId: id(value.userId, "体验账户 ID"),
      accessToken: value.accessToken,
      expiresAt: value.expiresAt,
      created: value.created,
      credits: value.credits as number,
      creditKind: "test",
      purchasable: false,
    };
  }

  async profile(): Promise<CloudProfile> {
    const value = await this.send("GET", "/v1/me");
    if (
      typeof value.displayName !== "string" || !Number.isInteger(value.credits)
      || value.creditKind !== "test" || value.purchasable !== false
    ) throw new Error("Write Cloud 测试账户响应格式无效。");
    return {
      id: id(value.id, "测试账户 ID"),
      displayName: value.displayName,
      credits: value.credits as number,
      creditKind: "test",
      purchasable: false,
    };
  }

  async addConnection(accountName: string, appid: string, appsecret: string): Promise<CloudConnection> {
    const value = await this.send("POST", "/v1/connections", true, {
      "Content-Type": "application/json; charset=utf-8",
    }, JSON.stringify({ accountName, appid, appsecret }));
    if (typeof value.accountName !== "string" || value.status !== "pending") throw new Error("Write Cloud 公众号连接响应格式无效。");
    return { id: id(value.id, "公众号连接 ID"), accountName: value.accountName, status: "pending" };
  }

  async verifyConnection(connectionId: string): Promise<CloudConnection> {
    const value = await this.send("POST", `/v1/connections/${encodeURIComponent(id(connectionId, "公众号连接 ID"))}/verify`);
    if (
      typeof value.accountName !== "string" || typeof value.verifiedAt !== "string"
      || value.status !== "verified" || typeof value.trialGranted !== "boolean"
      || !Number.isInteger(value.grantedCredits) || !Number.isInteger(value.balance)
    ) throw new Error("Write Cloud 公众号验证响应格式无效。");
    return {
      id: id(value.id, "公众号连接 ID"),
      accountName: value.accountName,
      accountId: id(value.accountId, "公众号账号 ID"),
      status: "verified",
      verifiedAt: value.verifiedAt,
      trialGranted: value.trialGranted,
      grantedCredits: value.grantedCredits as number,
      balance: value.balance as number,
    };
  }

  async createQuote(
    connectionId: string,
    operation: "create" | "update",
    contentHash: string,
    imageCount: number,
  ): Promise<CloudQuote> {
    const value = await this.send("POST", "/v1/quotes", true, {
      "Content-Type": "application/json; charset=utf-8",
    }, JSON.stringify({ connectionId, operation, contentHash: sha256(contentHash), imageCount }));
    if (
      (value.action !== "创建微信公众号草稿" && value.action !== "更新微信公众号草稿")
      || !Number.isInteger(value.imageCount) || !Number.isInteger(value.credits) || !Number.isInteger(value.balance)
      || value.testCredits !== true || value.purchasable !== false || typeof value.expiresAt !== "string"
    ) throw new Error("Write Cloud 报价响应格式无效。");
    return {
      id: id(value.id, "报价 ID"),
      connectionId: id(value.connectionId, "公众号连接 ID"),
      action: value.action,
      contentHash: sha256(String(value.contentHash)),
      imageCount: value.imageCount as number,
      credits: value.credits as number,
      balance: value.balance as number,
      testCredits: true,
      purchasable: false,
      expiresAt: value.expiresAt,
    };
  }

  async beginJob(quoteId: string, idempotencyKey: string, payloadHash: string): Promise<CloudJob> {
    const value = await this.send("POST", "/v1/jobs", true, {
      "Content-Type": "application/json; charset=utf-8",
    }, JSON.stringify({ quoteId, idempotencyKey, payloadHash: sha256(payloadHash) }));
    if (
      value.status !== "reserved" || (value.operation !== "create" && value.operation !== "update")
      || !Number.isInteger(value.reservedCredits) || !Number.isInteger(value.availableCredits)
    ) throw new Error("Write Cloud 任务预留响应格式无效。");
    this.activeJobId = id(value.id, "同步任务 ID");
    this.receipt = null;
    return {
      id: this.activeJobId,
      status: "reserved",
      operation: value.operation,
      reservedCredits: value.reservedCredits as number,
      availableCredits: value.availableCredits as number,
    };
  }

  async uploadAsset(input: AssetUploadInput): Promise<AssetResult> {
    const jobId = this.requireActiveJob();
    const contentHash = sha256(input.sha256);
    const value = await this.send("POST", `/v1/jobs/${jobId}/assets?kind=${input.kind}`, true, {
      "Content-Type": input.mimeType,
      "X-WriteX-Content-Hash": contentHash,
    }, input.bytes);
    if (typeof value.cached !== "boolean") throw new Error("Write Cloud 图片响应格式无效。");
    if (input.kind === "content") {
      if (typeof value.url !== "string" || !["http:", "https:"].includes(new URL(value.url).protocol)) {
        throw new Error("Write Cloud 正文图片响应格式无效。");
      }
      return { ok: true, kind: "content", sha256: contentHash, url: value.url, cached: value.cached };
    }
    return {
      ok: true,
      kind: "cover",
      sha256: contentHash,
      mediaId: id(value.mediaId, "封面素材 ID"),
      cached: value.cached,
    };
  }

  async createDraft(payload: DraftPayload, _idempotencyKey: string): Promise<DraftResult> {
    return this.sendDraft("POST", `/v1/jobs/${this.requireActiveJob()}/drafts`, payload);
  }

  async updateDraft(draftId: string, payload: DraftPayload, _idempotencyKey: string): Promise<DraftResult> {
    return this.sendDraft(
      "PUT", `/v1/jobs/${this.requireActiveJob()}/drafts/${encodeURIComponent(id(draftId, "草稿 ID"))}`, payload,
    );
  }

  async cancelJob(jobId = this.activeJobId): Promise<{ id: string; status: "cancelled"; releasedCredits: number }> {
    const value = await this.send("POST", `/v1/jobs/${encodeURIComponent(id(jobId, "同步任务 ID"))}/cancel`);
    if (value.status !== "cancelled" || !Number.isInteger(value.releasedCredits)) {
      throw new Error("Write Cloud 取消任务响应格式无效。");
    }
    if (jobId === this.activeJobId) this.activeJobId = "";
    return {
      id: id(value.id, "同步任务 ID"),
      status: "cancelled",
      releasedCredits: value.releasedCredits as number,
    };
  }

  private async sendDraft(method: "POST" | "PUT", path: string, payload: DraftPayload): Promise<DraftResult> {
    if (payload.content.includes("https://write.invalid/assets/")) throw new Error("正文仍包含未替换的图片占位符。");
    const value = await this.send(method, path, true, {
      "Content-Type": "application/json; charset=utf-8",
    }, JSON.stringify(payload));
    if (
      (value.operation !== "created" && value.operation !== "updated")
      || !Number.isInteger(value.imageCount) || !Number.isInteger(value.credits) || !Number.isInteger(value.balance)
      || typeof value.completedAt !== "string"
    ) throw new Error("Write Cloud 同步回执格式无效。");
    const receipt: CloudReceipt = {
      jobId: id(value.jobId, "同步任务 ID"),
      draftId: id(value.draftId, "草稿 ID"),
      operation: value.operation,
      imageCount: value.imageCount as number,
      credits: value.credits as number,
      balance: value.balance as number,
      completedAt: value.completedAt,
    };
    this.receipt = receipt;
    return { ok: true, draftId: receipt.draftId, operation: receipt.operation, cached: false };
  }

  private requireActiveJob(): string {
    if (!this.activeJobId) throw new Error("必须先确认报价并预留体验积分。");
    return this.activeJobId;
  }

  private async send(
    method: "GET" | "POST" | "PUT",
    path: string,
    authenticated = true,
    headers: Record<string, string> = {},
    body?: string | ArrayBuffer,
  ): Promise<Record<string, unknown>> {
    if (authenticated && !this.accessToken) throw new Error("请先连接 Write Cloud 体验账户。");
    const requestHeaders = authenticated
      ? { ...headers, Authorization: `Bearer ${this.accessToken}` }
      : headers;
    const response = await this.transport({ url: this.baseUrl + path, method, headers: requestHeaders, body });
    const value = object(response.json);
    if (response.status < 200 || response.status >= 300) {
      const error = object(value?.error);
      const code = typeof error?.code === "string" ? error.code : "cloud_request_failed";
      const message = typeof error?.message === "string" ? error.message : `Write Cloud 请求失败（HTTP ${response.status}）。`;
      throw new CloudError(
        this.accessToken ? message.split(this.accessToken).join("[redacted]") : message,
        code,
        response.status,
      );
    }
    if (!value) throw new Error("Write Cloud 响应格式无效。");
    return value;
  }
}
