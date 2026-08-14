import { Buffer } from "node:buffer";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PROTOCOL_ID = /^[A-Za-z0-9._-]+$/;

export function normalizeRelayUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("Relay URL 不能为空。");
  const url = new URL(value);
  const local = LOOPBACK_HOSTS.has(url.hostname);
  if (!local && url.protocol !== "https:") throw new Error("非本机 Relay 必须使用 HTTPS。");
  if (local && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("本机 Relay 必须使用 HTTP 或 HTTPS。");
  }
  if (url.username || url.password) throw new Error("Relay URL 不得包含凭据。");
  if (url.search || url.hash) throw new Error("Relay URL 不得包含查询参数或片段。");
  return url.toString().replace(/\/$/, "");
}

export function assertProtocolId(value: string): string {
  if (!value) throw new Error("协议 ID 不能为空。");
  if (value.length > 128) throw new Error("协议 ID 不能超过 128 个 ASCII 字符。");
  if (!PROTOCOL_ID.test(value)) throw new Error("协议 ID 只能包含安全 ASCII 字符。");
  return value;
}

export function encodeRelayFileName(value: string): string {
  if (!value) throw new Error("文件名不能为空。");
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("文件名不得包含控制字符。");
  if (Buffer.byteLength(value, "utf8") > 180) throw new Error("文件名不能超过 180 个 UTF-8 字节。");
  return encodeURIComponent(value);
}

export interface RelayTransportRequest {
  url: string;
  method: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface RelayTransportResult {
  status: number;
  json: unknown;
}

export type RelayTransport = (request: RelayTransportRequest) => Promise<RelayTransportResult>;

export interface VerifyResult {
  ok: true;
  protocolVersion: "v1";
  accountName: string;
  accountId: string;
  verifiedAt: string;
  outboundIp?: string;
}

export interface AssetUploadInput {
  kind: "content" | "cover";
  fileName: string;
  mimeType: string;
  sha256: string;
  idempotencyKey: string;
  bytes: ArrayBuffer;
}

export interface AssetResult {
  ok: true;
  kind: "content" | "cover";
  sha256: string;
  url?: string;
  mediaId?: string;
  cached: boolean;
}

export interface DraftPayload {
  title: string;
  author: string;
  digest: string;
  content: string;
  contentHash: string;
  coverMediaId: string;
  commentsEnabled: boolean;
  onlyFansCanComment: boolean;
}

export interface DraftResult {
  ok: true;
  draftId: string;
  operation: "created" | "updated";
  cached: boolean;
}

export class RelayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    message: string,
    code: string,
    status: number,
  ) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.status = status;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sha256(value: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("内容哈希必须是 SHA-256。");
  return value.toLowerCase();
}

export class WriteRelayClient {
  private readonly baseUrl: string;
  private readonly relayKey: string;
  private readonly transport: RelayTransport;

  constructor(
    baseUrl: string,
    relayKey: string,
    transport: RelayTransport,
  ) {
    this.baseUrl = normalizeRelayUrl(baseUrl);
    this.relayKey = relayKey;
    this.transport = transport;
  }

  async health(): Promise<{ ok: true; protocolVersion: "v1" }> {
    const value = await this.send("GET", "/v1/health", false);
    if (value.ok !== true || value.protocolVersion !== "v1") throw new Error("Relay 健康检查响应格式无效。");
    return { ok: true, protocolVersion: "v1" };
  }

  async verify(): Promise<VerifyResult> {
    const value = await this.send("POST", "/v1/verify");
    if (
      value.ok !== true
      || value.protocolVersion !== "v1"
      || typeof value.accountName !== "string"
      || typeof value.accountId !== "string"
      || typeof value.verifiedAt !== "string"
    ) throw new Error("Relay 验证响应格式无效。");
    return {
      ok: true,
      protocolVersion: "v1",
      accountName: value.accountName,
      accountId: assertProtocolId(value.accountId),
      verifiedAt: value.verifiedAt,
      outboundIp: typeof value.outboundIp === "string" ? value.outboundIp : undefined,
    };
  }

  async uploadAsset(input: AssetUploadInput): Promise<AssetResult> {
    const contentHash = sha256(input.sha256);
    assertProtocolId(input.idempotencyKey);
    const value = await this.send("POST", `/v1/assets?kind=${input.kind}`, true, {
      "Content-Type": input.mimeType,
      "X-Write-File-Name": encodeRelayFileName(input.fileName),
      "X-Write-Content-Hash": contentHash,
      "X-Write-Idempotency-Key": input.idempotencyKey,
    }, input.bytes);
    if (
      value.ok !== true
      || value.kind !== input.kind
      || value.sha256 !== contentHash
      || typeof value.cached !== "boolean"
    ) throw new Error("Relay 图片响应格式无效。");
    if (input.kind === "content") {
      if (typeof value.url !== "string" || !["http:", "https:"].includes(new URL(value.url).protocol)) {
        throw new Error("Relay 正文图片响应格式无效。");
      }
      return { ok: true, kind: input.kind, sha256: contentHash, url: value.url, cached: value.cached };
    }
    if (typeof value.mediaId !== "string") throw new Error("Relay 封面响应格式无效。");
    return {
      ok: true,
      kind: input.kind,
      sha256: contentHash,
      mediaId: assertProtocolId(value.mediaId),
      cached: value.cached,
    };
  }

  async createDraft(payload: DraftPayload, idempotencyKey: string): Promise<DraftResult> {
    return this.sendDraft("POST", "/v1/drafts", payload, idempotencyKey);
  }

  async updateDraft(draftId: string, payload: DraftPayload, idempotencyKey: string): Promise<DraftResult> {
    return this.sendDraft("PUT", `/v1/drafts/${encodeURIComponent(assertProtocolId(draftId))}`, payload, idempotencyKey);
  }

  private async sendDraft(
    method: "POST" | "PUT",
    path: string,
    payload: DraftPayload,
    idempotencyKey: string,
  ): Promise<DraftResult> {
    if (payload.content.includes("https://write.invalid/assets/")) {
      throw new Error("正文仍包含未替换的图片占位符。");
    }
    assertProtocolId(idempotencyKey);
    const value = await this.send(method, path, true, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Write-Idempotency-Key": idempotencyKey,
    }, JSON.stringify(payload));
    if (
      value.ok !== true
      || typeof value.draftId !== "string"
      || (value.operation !== "created" && value.operation !== "updated")
      || typeof value.cached !== "boolean"
    ) throw new Error("Relay 草稿响应格式无效。");
    return {
      ok: true,
      draftId: assertProtocolId(value.draftId),
      operation: value.operation,
      cached: value.cached,
    };
  }

  private async send(
    method: "GET" | "POST" | "PUT",
    path: string,
    authenticated = true,
    headers: Record<string, string> = {},
    body?: string | ArrayBuffer,
  ): Promise<Record<string, unknown>> {
    if (authenticated && !this.relayKey) throw new Error("请先保存 Relay Key。");
    const requestHeaders = authenticated
      ? { ...headers, "X-Write-Relay-Key": this.relayKey }
      : headers;
    const response = await this.transport({ url: this.baseUrl + path, method, headers: requestHeaders, body });
    const value = object(response.json);
    if (response.status < 200 || response.status >= 300) {
      const error = object(value?.error);
      const code = typeof error?.code === "string" ? error.code : "relay_request_failed";
      const rawMessage = typeof error?.message === "string" ? error.message : `Relay 请求失败（HTTP ${response.status}）。`;
      const safeMessage = this.relayKey ? rawMessage.split(this.relayKey).join("[redacted]") : rawMessage;
      throw new RelayError(safeMessage, code, response.status);
    }
    if (!value) throw new Error("Relay 响应格式无效。");
    return value;
  }
}
