import { createReadStream, existsSync, mkdirSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  optionalInteger,
  ProtocolError,
  requiredString,
  MAX_MESSAGE_ATTACHMENT_COUNT,
  MAX_MESSAGE_ATTACHMENT_SIZE,
  MAX_MESSAGE_ATTACHMENT_TOTAL_SIZE,
  type CodexRecordEntry,
  type CodexRuntimeStatus,
  type CodexThreadCatalogEntry,
  type MessageAttachmentInput,
  type MessageDeliveryStatus,
  type MessageKind,
  type RealtimeEnvelope,
  type RoomStatus,
  type WorkspaceFileContent,
  type WorkspaceFileOperation,
  type WorkspaceFileOperationEvent,
} from "@codex-collab/protocol";
import {
  parseCodexOptions,
  validateCodexPromptCapabilities,
} from "./codex-options.js";
import { buildInviteLink, resolveInviteOrigin } from "./invite-link.js";
import {
  AccountAuthService,
  resolvePasskeyConfig,
  type PasskeyRequestConfig,
} from "./account-auth.js";
import { SessionStore, type AccountSessionIdentity } from "./session-store.js";
import {
  RealtimeTicketStore,
  type RealtimeTicketIdentity,
} from "./realtime-tickets.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const relayRoot = join(moduleDir, "..");
const publicRoot = join(relayRoot, "public");
const dataDir = process.env.CODEX_COLLAB_DATA_DIR ?? join(relayRoot, ".data");
const databasePath = process.env.CODEX_COLLAB_DATABASE ?? join(dataDir, "relay.sqlite");
const port = Number.parseInt(process.env.PORT ?? "4177", 10);
const host = process.env.HOST ?? "127.0.0.1";
const configuredPublicUrl = process.env.CODEX_COLLAB_PUBLIC_URL;
const configuredPasskeyOrigin =
  process.env.CODEX_COLLAB_PASSKEY_ORIGIN ?? configuredPublicUrl;
const configuredPasskeyRpId = process.env.CODEX_COLLAB_PASSKEY_RP_ID;
const configuredPasskeyRpName = process.env.CODEX_COLLAB_PASSKEY_RP_NAME;
const trustProxy = process.env.CODEX_COLLAB_TRUST_PROXY === "1";
const allowLegacyRealtimeTokens =
  process.env.CODEX_COLLAB_ALLOW_LEGACY_REALTIME_TOKENS !== "0";

mkdirSync(dataDir, { recursive: true });
const store = new SessionStore(databasePath);
const accountAuth = new AccountAuthService(store);
const realtimeTickets = new RealtimeTicketStore();
const socketsBySession = new Map<string, Set<WebSocket>>();
const socketsByAccountSession = new Map<string, Set<WebSocket>>();
const webSockets = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024,
  perMessageDeflate: false,
});
const requestAttempts = new Map<string, { count: number; resetAt: number }>();

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(payload);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof ProtocolError) {
    sendJson(response, error.statusCode, {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  console.error(error);
  sendJson(response, 500, {
    error: { code: "internal_error", message: "The relay could not complete the request" },
  });
}

function sendAttachment(
  response: ServerResponse,
  attachment: {
    name: string;
    media_type: string;
    size: number;
    content: Uint8Array;
  },
): void {
  response.writeHead(200, {
    "content-type": attachment.media_type,
    "content-length": attachment.size,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(Buffer.from(attachment.content));
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 128_000,
): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ProtocolError(
      415,
      "unsupported_media_type",
      "JSON requests require Content-Type: application/json",
    );
  }
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ProtocolError(413, "payload_too_large", "Request body is too large");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) {
      throw new ProtocolError(413, "payload_too_large", "Request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("object required");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ProtocolError(400, "invalid_json", "Request body must be a JSON object");
  }
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "invalid_request", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseThreadCatalog(value: unknown): CodexThreadCatalogEntry[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new ProtocolError(400, "invalid_request", "threads must contain at most 100 tasks");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ProtocolError(400, "invalid_request", `threads[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const updatedAt =
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : null;
    return {
      id: requiredString(record.id, `threads[${index}].id`, 120),
      name:
        typeof record.name === "string" && record.name.trim()
          ? record.name.trim().slice(0, 200)
          : null,
      preview:
        typeof record.preview === "string" ? record.preview.trim().slice(0, 1_000) : "",
      updatedAt,
    };
  });
}

function parseHistory(value: unknown): CodexRecordEntry[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new ProtocolError(400, "invalid_request", "history must contain at most 500 entries");
  }
  let totalLength = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ProtocolError(400, "invalid_request", `history[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (
      record.role !== "user" &&
      record.role !== "assistant" &&
      record.role !== "reasoning" &&
      record.role !== "command"
    ) {
      throw new ProtocolError(
        400,
        "invalid_request",
        `history[${index}].role is invalid`,
      );
    }
    const text = requiredString(record.text, `history[${index}].text`, 50_000);
    const phase =
      record.role === "assistant" &&
      (record.phase === "commentary" || record.phase === "final_answer")
        ? record.phase
        : null;
    totalLength += text.length;
    if (totalLength > 2_000_000) {
      throw new ProtocolError(413, "history_too_large", "Imported Codex history is too large");
    }
    return {
      id: requiredString(record.id, `history[${index}].id`, 160),
      role: record.role,
      ...(phase ? { phase } : {}),
      text,
      createdAt:
        typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt))
          ? new Date(record.createdAt).toISOString()
          : null,
    };
  });
}

function parseWorkspaceFiles(value: unknown): WorkspaceFileContent[] {
  if (!Array.isArray(value) || value.length > 600) {
    throw new ProtocolError(400, "invalid_request", "files must contain at most 600 files");
  }
  let totalLength = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ProtocolError(400, "invalid_request", `files[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const path = requiredString(record.path, `files[${index}].path`, 500).replaceAll("\\", "/");
    if (path.startsWith("/") || path.split("/").some((segment) => segment === "..")) {
      throw new ProtocolError(400, "invalid_request", `files[${index}].path is unsafe`);
    }
    const content =
      typeof record.content === "string"
        ? record.content
        : (() => {
            throw new ProtocolError(
              400,
              "invalid_request",
              `files[${index}].content must be a string`,
            );
          })();
    totalLength += Buffer.byteLength(content);
    if (Buffer.byteLength(content) > 256_000 || totalLength > 5_000_000) {
      throw new ProtocolError(413, "workspace_too_large", "Shared file snapshot is too large");
    }
    const size = record.size;
    if (!Number.isInteger(size) || (size as number) < 0 || (size as number) > 256_000) {
      throw new ProtocolError(400, "invalid_request", `files[${index}].size is invalid`);
    }
    const sha256 = requiredString(record.sha256, `files[${index}].sha256`, 64);
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new ProtocolError(400, "invalid_request", `files[${index}].sha256 is invalid`);
    }
    const modifiedAt = requiredString(record.modifiedAt, `files[${index}].modifiedAt`, 40);
    if (Number.isNaN(Date.parse(modifiedAt))) {
      throw new ProtocolError(400, "invalid_request", `files[${index}].modifiedAt is invalid`);
    }
    return {
      path,
      content,
      size: size as number,
      sha256,
      modifiedAt: new Date(modifiedAt).toISOString(),
    };
  });
}

function parseWorkspaceFileOperationRequest(
  body: Record<string, unknown>,
):
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; content: string; expectedSha256: string } {
  const path = requiredString(body.path, "path", 500);
  if (body.kind === "read") {
    if (body.content !== undefined || body.expectedSha256 !== undefined) {
      throw new ProtocolError(
        400,
        "invalid_request",
        "Read operations do not accept content or expectedSha256",
      );
    }
    return { kind: "read", path };
  }
  if (body.kind !== "write") {
    throw new ProtocolError(400, "invalid_request", "kind must be read or write");
  }
  if (typeof body.content !== "string") {
    throw new ProtocolError(400, "invalid_request", "content must be a string");
  }
  if (typeof body.expectedSha256 !== "string") {
    throw new ProtocolError(
      400,
      "invalid_request",
      "expectedSha256 is required for every write",
    );
  }
  return {
    kind: "write",
    path,
    content: body.content,
    expectedSha256: body.expectedSha256,
  };
}

function parseWorkspaceOperationResultFile(value: unknown): WorkspaceFileContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "invalid_request", "file must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.content !== "string") {
    throw new ProtocolError(400, "invalid_request", "file.content must be a string");
  }
  if (!Number.isInteger(record.size) || (record.size as number) < 0) {
    throw new ProtocolError(400, "invalid_request", "file.size is invalid");
  }
  return {
    path: requiredString(record.path, "file.path", 500),
    content: record.content,
    size: record.size as number,
    modifiedAt: requiredString(record.modifiedAt, "file.modifiedAt", 40),
    sha256: requiredString(record.sha256, "file.sha256", 64),
  };
}

function toWorkspaceFileOperationEvent(
  operation: WorkspaceFileOperation,
): WorkspaceFileOperationEvent {
  return {
    operationId: operation.id,
    requestedByMemberId: operation.requestedByMemberId,
    status: operation.status,
  };
}

function parseMessageAttachments(value: unknown): Array<{
  name: string;
  mediaType: string;
  size: number;
  content: Uint8Array;
}> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_ATTACHMENT_COUNT) {
    throw new ProtocolError(
      400,
      "invalid_request",
      `attachments must contain at most ${MAX_MESSAGE_ATTACHMENT_COUNT} files`,
    );
  }
  let totalSize = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ProtocolError(400, "invalid_request", `attachments[${index}] must be an object`);
    }
    const record = item as Partial<MessageAttachmentInput> & Record<string, unknown>;
    const name = requiredString(record.name, `attachments[${index}].name`, 180);
    if (
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      /[<>:"|?*]/.test(name) ||
      /[. ]$/.test(name) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
      /[\u0000-\u001f]/.test(name)
    ) {
      throw new ProtocolError(400, "invalid_request", `attachments[${index}].name is unsafe`);
    }
    const mediaType =
      typeof record.mediaType === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(
        record.mediaType,
      )
        ? record.mediaType
        : "application/octet-stream";
    if (
      !Number.isInteger(record.size) ||
      (record.size as number) < 0 ||
      (record.size as number) > MAX_MESSAGE_ATTACHMENT_SIZE
    ) {
      throw new ProtocolError(400, "invalid_request", `attachments[${index}].size is invalid`);
    }
    if (
      typeof record.dataBase64 !== "string" ||
      record.dataBase64.length === 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(record.dataBase64)
    ) {
      throw new ProtocolError(
        400,
        "invalid_request",
        `attachments[${index}].dataBase64 is invalid`,
      );
    }
    const content = Buffer.from(record.dataBase64, "base64");
    if (content.length !== record.size) {
      throw new ProtocolError(
        400,
        "invalid_request",
        `attachments[${index}].size does not match its content`,
      );
    }
    totalSize += content.length;
    if (totalSize > MAX_MESSAGE_ATTACHMENT_TOTAL_SIZE) {
      throw new ProtocolError(
        413,
        "attachments_too_large",
        `Attachments exceed the ${MAX_MESSAGE_ATTACHMENT_TOTAL_SIZE / 1_000_000} MB limit`,
      );
    }
    return {
      name,
      mediaType,
      size: content.length,
      content,
    };
  });
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new ProtocolError(401, "unauthorized", "Bearer token is required");
  }
  return authorization.slice("Bearer ".length).trim();
}

function passkeyConfig(request: IncomingMessage): PasskeyRequestConfig {
  return resolvePasskeyConfig({
    ...(configuredPasskeyOrigin
      ? { configuredOrigin: configuredPasskeyOrigin }
      : {}),
    ...(configuredPasskeyRpId ? { configuredRpId: configuredPasskeyRpId } : {}),
    ...(configuredPasskeyRpName ? { rpName: configuredPasskeyRpName } : {}),
    ...(request.headers.host ? { requestHost: request.headers.host } : {}),
  });
}

function cookieName(kind: "account" | "ceremony", secure: boolean): string {
  if (secure) {
    return kind === "account"
      ? "__Host-codex_collab_account"
      : "__Host-codex_collab_passkey";
  }
  return kind === "account"
    ? "codex_collab_account_local"
    : "codex_collab_passkey_local";
}

function cookieValue(request: IncomingMessage, name: string): string | null {
  const values = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (values.length > 1) {
    throw new ProtocolError(400, "invalid_cookie", "Duplicate authentication cookie");
  }
  const value = values[0];
  return value && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

function setCookie(
  kind: "account" | "ceremony",
  value: string,
  config: PasskeyRequestConfig,
  maxAgeSeconds: number,
): string {
  return [
    `${cookieName(kind, config.secureCookies)}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(config.secureCookies ? ["Secure"] : []),
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

function clearCookie(
  kind: "account" | "ceremony",
  config: PasskeyRequestConfig,
): string {
  return setCookie(kind, "deleted", config, 0);
}

function assertAccountRequestOrigin(
  request: IncomingMessage,
  config: PasskeyRequestConfig,
): void {
  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw new ProtocolError(403, "cross_site_request", "Cross-site request was rejected");
  }
  if (request.headers.origin !== config.origin) {
    throw new ProtocolError(403, "origin_mismatch", "Request origin was rejected");
  }
}

function clientAddress(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  return (
    (trustProxy && typeof forwarded === "string"
      ? forwarded.split(",", 1)[0]?.trim()
      : request.socket.remoteAddress) || "unknown"
  );
}

function enforceRateLimit(
  request: IncomingMessage,
  bucket: string,
  limit = 20,
  windowMs = 5 * 60_000,
): void {
  const key = `${bucket}:${clientAddress(request)}`;
  const currentTime = Date.now();
  if (requestAttempts.size >= 10_000) {
    for (const [attemptKey, attempt] of requestAttempts) {
      if (attempt.resetAt <= currentTime) requestAttempts.delete(attemptKey);
    }
    while (requestAttempts.size >= 10_000) {
      const oldest = requestAttempts.keys().next().value as string | undefined;
      if (!oldest) break;
      requestAttempts.delete(oldest);
    }
  }
  const existing = requestAttempts.get(key);
  if (!existing || existing.resetAt <= currentTime) {
    requestAttempts.set(key, { count: 1, resetAt: currentTime + windowMs });
    return;
  }
  if (existing.count >= limit) {
    throw new ProtocolError(
      429,
      "rate_limited",
      "Too many requests; try again later",
    );
  }
  existing.count += 1;
}

function requireCsrfToken(request: IncomingMessage): string {
  const value = request.headers["x-codex-csrf"];
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,200}$/.test(value)) {
    throw new ProtocolError(
      403,
      "account_csrf_invalid",
      "Account request could not be verified",
    );
  }
  return value;
}

function optionalAccountForWrite(
  request: IncomingMessage,
  config: PasskeyRequestConfig,
): AccountSessionIdentity | null {
  const token = cookieValue(request, cookieName("account", config.secureCookies));
  if (!token) return null;
  try {
    store.accountFromSessionToken(token);
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "account_required") {
      return null;
    }
    throw error;
  }
  assertAccountRequestOrigin(request, config);
  return store.validateAccountWriteSession(token, requireCsrfToken(request));
}

function requireAccountForWrite(
  request: IncomingMessage,
  config: PasskeyRequestConfig,
): AccountSessionIdentity {
  const token = cookieValue(request, cookieName("account", config.secureCookies));
  if (!token) {
    throw new ProtocolError(401, "account_required", "Account sign-in is required");
  }
  assertAccountRequestOrigin(request, config);
  return store.validateAccountWriteSession(token, requireCsrfToken(request));
}

function optionalConfiguredAccountForWrite(
  request: IncomingMessage,
): AccountSessionIdentity | null {
  try {
    const config = passkeyConfig(request);
    return optionalAccountForWrite(request, config);
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "passkey_not_configured") {
      return null;
    }
    throw error;
  }
}

function broadcast(sessionId: string, type: RealtimeEnvelope["type"], payload: unknown): void {
  const envelope: RealtimeEnvelope = {
    type,
    sessionId,
    payload,
    sentAt: new Date().toISOString(),
  };
  const data = JSON.stringify(envelope);
  for (const socket of socketsBySession.get(sessionId) ?? []) {
    if (socket.readyState === WebSocket.OPEN) {
      if (socket.bufferedAmount > 1_000_000) {
        socket.terminate();
        continue;
      }
      socket.send(data, (error) => {
        if (error) socket.terminate();
      });
    }
  }
}

function rejectUpgrade(socket: Duplex, statusCode: 401 | 403 | 404): void {
  const reason =
    statusCode === 401 ? "Unauthorized" : statusCode === 403 ? "Forbidden" : "Not Found";
  socket.end(
    `HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`,
  );
}

function closeAccountSessionSockets(accountSessionId: string): void {
  for (const socket of socketsByAccountSession.get(accountSessionId) ?? []) {
    socket.close(4001, "Account signed out");
  }
}

function serveDashboard(response: ServerResponse): void {
  const file = join(publicRoot, "index.html");
  if (!existsSync(file)) {
    sendJson(response, 404, { error: { code: "dashboard_missing", message: "Dashboard not built" } });
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
  });
  createReadStream(file).pipe(response);
}

function serveDashboardAsset(pathname: string, response: ServerResponse): void {
  const match = pathname.match(/^\/assets\/([A-Za-z0-9._-]+)$/);
  if (!match?.[1]) {
    sendJson(response, 404, { error: { code: "asset_not_found", message: "Asset was not found" } });
    return;
  }
  const file = join(publicRoot, "assets", match[1]);
  if (!existsSync(file)) {
    sendJson(response, 404, { error: { code: "asset_not_found", message: "Asset was not found" } });
    return;
  }
  const extension = match[1].split(".").pop()?.toLowerCase();
  const contentType =
    extension === "js"
      ? "text/javascript; charset=utf-8"
      : extension === "css"
        ? "text/css; charset=utf-8"
        : "application/octet-stream";
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "public, max-age=31536000, immutable",
  });
  createReadStream(file).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (method === "GET" && url.pathname === "/") {
      serveDashboard(response);
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/assets/")) {
      serveDashboardAsset(url.pathname, response);
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        service: "codex-collab-relay",
        version: "0.1.0",
        time: new Date().toISOString(),
      });
      return;
    }

    if (
      method === "POST" &&
      url.pathname === "/v1/auth/passkey/registration/options"
    ) {
      const config = passkeyConfig(request);
      assertAccountRequestOrigin(request, config);
      enforceRateLimit(request, "registration-options", 10);
      const body = await readJson(request);
      const result = await accountAuth.beginRegistration(
        requiredString(body.displayName, "displayName", 80),
        config,
      );
      sendJson(
        response,
        200,
        { options: result.options },
        {
          "set-cookie": setCookie("ceremony", result.ceremonyToken, config, 300),
        },
      );
      return;
    }

    if (
      method === "POST" &&
      url.pathname === "/v1/auth/passkey/registration/verify"
    ) {
      const config = passkeyConfig(request);
      assertAccountRequestOrigin(request, config);
      enforceRateLimit(request, "registration-verify", 15);
      const body = await readJson(request);
      const ceremonyToken = cookieValue(
        request,
        cookieName("ceremony", config.secureCookies),
      );
      if (!ceremonyToken) {
        throw new ProtocolError(
          400,
          "passkey_challenge_invalid",
          "Start passkey registration again",
        );
      }
      const result = await accountAuth.finishRegistration(
        ceremonyToken,
        requiredObject(body.response, "response") as unknown as RegistrationResponseJSON,
      );
      const profile = store.getAccountProfile(result.account.id);
      sendJson(
        response,
        201,
        { ...profile, csrfToken: result.csrfToken },
        {
          "set-cookie": [
            setCookie("account", result.accountSessionToken, config, 30 * 24 * 60 * 60),
            clearCookie("ceremony", config),
          ],
        },
      );
      return;
    }

    if (
      method === "POST" &&
      url.pathname === "/v1/auth/passkey/authentication/options"
    ) {
      const config = passkeyConfig(request);
      assertAccountRequestOrigin(request, config);
      enforceRateLimit(request, "authentication-options", 20);
      await readJson(request);
      const result = await accountAuth.beginAuthentication(config);
      sendJson(
        response,
        200,
        { options: result.options },
        {
          "set-cookie": setCookie("ceremony", result.ceremonyToken, config, 300),
        },
      );
      return;
    }

    if (
      method === "POST" &&
      url.pathname === "/v1/auth/passkey/authentication/verify"
    ) {
      const config = passkeyConfig(request);
      assertAccountRequestOrigin(request, config);
      enforceRateLimit(request, "authentication-verify", 20);
      const body = await readJson(request);
      const ceremonyToken = cookieValue(
        request,
        cookieName("ceremony", config.secureCookies),
      );
      if (!ceremonyToken) {
        throw new ProtocolError(
          400,
          "passkey_challenge_invalid",
          "Start passkey sign-in again",
        );
      }
      const result = await accountAuth.finishAuthentication(
        ceremonyToken,
        requiredObject(body.response, "response") as unknown as AuthenticationResponseJSON,
      );
      const profile = store.getAccountProfile(result.account.id);
      sendJson(
        response,
        200,
        { ...profile, csrfToken: result.csrfToken },
        {
          "set-cookie": [
            setCookie("account", result.accountSessionToken, config, 30 * 24 * 60 * 60),
            clearCookie("ceremony", config),
          ],
        },
      );
      return;
    }

    if (method === "GET" && url.pathname === "/v1/account") {
      const config = passkeyConfig(request);
      const accountSessionToken = cookieValue(
        request,
        cookieName("account", config.secureCookies),
      );
      if (!accountSessionToken) {
        throw new ProtocolError(401, "account_required", "Account sign-in is required");
      }
      const refreshed = store.refreshAccountSession(accountSessionToken);
      sendJson(response, 200, {
        ...store.getAccountProfile(refreshed.account.id),
        csrfToken: refreshed.csrfToken,
      });
      return;
    }

    if (method === "POST" && url.pathname === "/v1/account/logout") {
      const config = passkeyConfig(request);
      await readJson(request);
      const identity = requireAccountForWrite(request, config);
      const accountSessionToken = cookieValue(
        request,
        cookieName("account", config.secureCookies),
      );
      if (accountSessionToken) store.logoutAccount(accountSessionToken);
      closeAccountSessionSockets(identity.accountSessionId);
      sendJson(
        response,
        200,
        { signedOut: true },
        { "set-cookie": clearCookie("account", config) },
      );
      return;
    }

    if (method === "POST" && url.pathname === "/v1/account/rooms/link") {
      const config = passkeyConfig(request);
      const body = await readJson(request);
      const identity = requireAccountForWrite(request, config);
      const profile = store.bindAccountMembership(
        identity.account.id,
        requiredString(body.sessionId, "sessionId", 120),
        bearerToken(request),
      );
      sendJson(response, 200, { ...profile, csrfToken: requireCsrfToken(request) });
      return;
    }

    const restoreAccountRoomMatch = url.pathname.match(
      /^\/v1\/account\/rooms\/([^/]+)\/restore$/,
    );
    if (method === "POST" && restoreAccountRoomMatch?.[1]) {
      const config = passkeyConfig(request);
      const body = await readJson(request);
      const identity = requireAccountForWrite(request, config);
      const result = store.restoreAccountRoom(
        identity.account.id,
        restoreAccountRoomMatch[1],
        typeof body.deviceLabel === "string"
          ? body.deviceLabel.trim().slice(0, 120) || "Web device"
          : "Web device",
        identity.accountSessionId,
        identity.expiresAt,
      );
      sendJson(response, 200, result);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/sessions") {
      enforceRateLimit(request, "session-create", 20, 15 * 60_000);
      const body = await readJson(request);
      const account = optionalConfiguredAccountForWrite(request);
      const result = store.createSession(
        requiredString(body.name, "name", 120),
        requiredString(body.ownerDisplayName, "ownerDisplayName", 80),
        typeof body.deviceLabel === "string" ? body.deviceLabel.slice(0, 120) : undefined,
        account ?? undefined,
      );
      sendJson(response, 201, result);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/invites/join") {
      enforceRateLimit(request, "invite-join", 30);
      const body = await readJson(request);
      const account = optionalConfiguredAccountForWrite(request);
      const result = store.joinInvite(
        requiredString(body.inviteToken, "inviteToken", 200),
        requiredString(body.displayName, "displayName", 80),
        typeof body.deviceLabel === "string" ? body.deviceLabel.slice(0, 120) : undefined,
        account ?? undefined,
      );
      broadcast(result.session.id, "member.updated", result.member);
      sendJson(response, 201, result);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/host-pairings/claim") {
      enforceRateLimit(request, "host-pairing-claim", 30);
      const body = await readJson(request);
      const result = store.claimHostPairing(
        requiredString(body.pairingToken, "pairingToken", 200),
        requiredString(body.deviceLabel, "deviceLabel", 120),
        requiredString(body.rootLabel, "rootLabel", 200),
      );
      broadcast(result.session.id, "workspace.updated", { hostConnected: true });
      sendJson(response, 201, result);
      return;
    }

    const inviteMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/invites$/);
    if (method === "POST" && inviteMatch?.[1]) {
      const sessionId = inviteMatch[1];
      const body = await readJson(request);
      const expiresInMinutes = optionalInteger(
        body.expiresInMinutes,
        60,
        "expiresInMinutes",
        5,
        10_080,
      );
      const maxUses = optionalInteger(body.maxUses, 1, "maxUses", 1, 20);
      const invite = store.createInvite(
        sessionId,
        bearerToken(request),
        expiresInMinutes,
        maxUses,
      );
      sendJson(response, 201, {
        sessionId,
        ...invite,
        inviteLink: buildInviteLink(
          resolveInviteOrigin({
            ...(configuredPublicUrl ? { configuredPublicUrl } : {}),
            ...(typeof request.headers["x-forwarded-proto"] === "string"
              ? { forwardedProto: request.headers["x-forwarded-proto"] }
              : {}),
            ...(request.headers.host ? { hostHeader: request.headers.host } : {}),
            listenHost: host,
            listenPort: port,
            trustProxy,
          }),
          invite.inviteToken,
        ),
      });
      return;
    }

    const pairingMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/host-pairings$/);
    if (method === "POST" && pairingMatch?.[1]) {
      const body = await readJson(request);
      const expiresInMinutes = optionalInteger(
        body.expiresInMinutes,
        10,
        "expiresInMinutes",
        2,
        30,
      );
      const pairing = store.createHostPairing(
        pairingMatch[1],
        bearerToken(request),
        expiresInMinutes,
      );
      sendJson(response, 201, { sessionId: pairingMatch[1], ...pairing });
      return;
    }

    const roomStatusMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/room-status$/,
    );
    if (method === "PUT" && roomStatusMatch?.[1]) {
      const body = await readJson(request);
      if (body.roomStatus !== "open" && body.roomStatus !== "closed") {
        throw new ProtocolError(
          400,
          "invalid_request",
          "roomStatus must be open or closed",
        );
      }
      const session = store.updateRoomStatus(
        roomStatusMatch[1],
        bearerToken(request),
        body.roomStatus as RoomStatus,
      );
      broadcast(roomStatusMatch[1], "session.updated", session);
      sendJson(response, 200, { session });
      return;
    }

    const meMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/me$/);
    if (method === "GET" && meMatch?.[1]) {
      sendJson(response, 200, {
        member: store.getCurrentMember(meMatch[1], bearerToken(request)),
        session: store.getSession(meMatch[1]),
      });
      return;
    }

    const realtimeTicketMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/realtime-tickets$/,
    );
    if (method === "POST" && realtimeTicketMatch?.[1]) {
      enforceRateLimit(request, "realtime-ticket", 120, 60_000);
      await readJson(request, 4_096);
      const sessionId = realtimeTicketMatch[1];
      const memberToken = bearerToken(request);
      const member = store.authenticateRealtime(sessionId, memberToken);
      const ticket = realtimeTickets.issue({
        sessionId,
        member,
        session: store.getSession(sessionId),
        accountSessionId: store.accountSessionForMemberToken(sessionId, memberToken),
      });
      sendJson(response, 201, ticket);
      return;
    }

    const membersMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/members$/);
    if (method === "GET" && membersMatch?.[1]) {
      sendJson(response, 200, {
        members: store.listMembers(membersMatch[1], bearerToken(request)),
      });
      return;
    }

    const approveMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/members\/([^/]+)\/approve$/,
    );
    if (method === "POST" && approveMatch?.[1] && approveMatch[2]) {
      const member = store.approveMember(
        approveMatch[1],
        bearerToken(request),
        approveMatch[2],
      );
      broadcast(approveMatch[1], "member.updated", member);
      sendJson(response, 200, { member });
      return;
    }

    const workspaceAccessMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/members\/([^/]+)\/workspace-file-access$/,
    );
    if (
      method === "PATCH" &&
      workspaceAccessMatch?.[1] &&
      workspaceAccessMatch[2]
    ) {
      const body = await readJson(request);
      if (
        body.workspaceFileAccess !== "read-only" &&
        body.workspaceFileAccess !== "workspace-write"
      ) {
        throw new ProtocolError(
          400,
          "invalid_request",
          "workspaceFileAccess must be read-only or workspace-write",
        );
      }
      const member = store.updateMemberWorkspaceFileAccess(
        workspaceAccessMatch[1],
        bearerToken(request),
        workspaceAccessMatch[2],
        body.workspaceFileAccess,
      );
      broadcast(workspaceAccessMatch[1], "member.updated", member);
      sendJson(response, 200, { member });
      return;
    }

    const messagesMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
    if (messagesMatch?.[1] && method === "GET") {
      const after = url.searchParams.get("after") ?? undefined;
      sendJson(response, 200, {
        messages: store.listMessages(messagesMatch[1], bearerToken(request), after),
      });
      return;
    }
    if (messagesMatch?.[1] && method === "POST") {
      enforceRateLimit(request, "message-create", 120, 60_000);
      const body = await readJson(request, 9_000_000);
      const kind = body.kind ?? "chat";
      if (kind !== "chat" && kind !== "codex_prompt" && kind !== "codex_stop") {
        throw new ProtocolError(
          400,
          "invalid_request",
          "kind must be chat, codex_prompt or codex_stop",
        );
      }
      const attachments = parseMessageAttachments(body.attachments);
      if (kind === "codex_stop" && attachments.length > 0) {
        throw new ProtocolError(
          400,
          "invalid_request",
          "attachments are supported only for chat and Codex prompts",
        );
      }
      const codexOptions =
        kind === "codex_prompt" ? parseCodexOptions(body.codexOptions) : null;
      if (codexOptions) {
        validateCodexPromptCapabilities(codexOptions, attachments);
      }
      const message = store.addMessage(
        messagesMatch[1],
        bearerToken(request),
        kind as MessageKind,
        requiredString(body.body, "body", 50_000),
        {
          attachments,
          codexOptions,
        },
      );
      broadcast(messagesMatch[1], "message.created", message);
      sendJson(response, 201, { message });
      return;
    }

    const attachmentMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/messages\/([^/]+)\/attachments\/([^/]+)$/,
    );
    if (
      method === "GET" &&
      attachmentMatch?.[1] &&
      attachmentMatch[2] &&
      attachmentMatch[3]
    ) {
      sendAttachment(
        response,
        store.getMessageAttachment(
          attachmentMatch[1],
          bearerToken(request),
          attachmentMatch[2],
          attachmentMatch[3],
        ),
      );
      return;
    }

    const messageStatusMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/messages\/([^/]+)\/status$/,
    );
    if (method === "PATCH" && messageStatusMatch?.[1] && messageStatusMatch[2]) {
      const body = await readJson(request);
      if (
        body.status !== "queued" &&
        body.status !== "submitted" &&
        body.status !== "completed" &&
        body.status !== "failed"
      ) {
        throw new ProtocolError(400, "invalid_request", "status is invalid");
      }
      const codexTurnId =
        body.codexTurnId === undefined || body.codexTurnId === null
          ? null
          : requiredString(body.codexTurnId, "codexTurnId", 160);
      const message = store.updateMessageDeliveryStatus(
        messageStatusMatch[1],
        bearerToken(request),
        messageStatusMatch[2],
        body.status as MessageDeliveryStatus,
        codexTurnId,
      );
      broadcast(messageStatusMatch[1], "message.created", message);
      sendJson(response, 200, { message });
      return;
    }

    const workspaceMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/workspace$/);
    if (method === "GET" && workspaceMatch?.[1]) {
      sendJson(response, 200, {
        workspace: store.getWorkspace(workspaceMatch[1], bearerToken(request)),
      });
      return;
    }

    const workspaceRuntimeMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/runtime$/,
    );
    if (method === "PUT" && workspaceRuntimeMatch?.[1]) {
      const body = await readJson(request);
      if (
        body.status !== "unavailable" &&
        body.status !== "idle" &&
        body.status !== "running"
      ) {
        throw new ProtocolError(400, "invalid_request", "Codex runtime status is invalid");
      }
      const result = store.publishCodexRuntimeStatus(
        workspaceRuntimeMatch[1],
        bearerToken(request),
        body.status as CodexRuntimeStatus,
      );
      if (result.changed) {
        broadcast(workspaceRuntimeMatch[1], "workspace.updated", {
          codexRuntimeStatus: result.workspace.codexRuntimeStatus,
        });
      }
      sendJson(response, 200, { workspace: result.workspace });
      return;
    }

    const workspaceCatalogMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/catalog$/,
    );
    if (method === "PUT" && workspaceCatalogMatch?.[1]) {
      const body = await readJson(request);
      const workspace = store.publishWorkspaceCatalog(
        workspaceCatalogMatch[1],
        bearerToken(request),
        {
          deviceLabel: requiredString(body.deviceLabel, "deviceLabel", 120),
          rootLabel: requiredString(body.rootLabel, "rootLabel", 200),
          threads: parseThreadCatalog(body.threads),
        },
      );
      broadcast(workspaceCatalogMatch[1], "workspace.updated", {
        hostConnected: true,
        taskCount: workspace.threads.length,
      });
      sendJson(response, 200, { workspace });
      return;
    }

    const workspaceSelectionMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/selection$/,
    );
    if (method === "PUT" && workspaceSelectionMatch?.[1]) {
      const body = await readJson(request);
      const workspace = store.selectWorkspaceThread(
        workspaceSelectionMatch[1],
        bearerToken(request),
        requiredString(body.threadId, "threadId", 120),
      );
      broadcast(workspaceSelectionMatch[1], "workspace.updated", {
        selectedThreadId: workspace.selectedThreadId,
        syncedAt: null,
      });
      sendJson(response, 200, { workspace });
      return;
    }

    const workspaceHistoryMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/history$/,
    );
    if (method === "PUT" && workspaceHistoryMatch?.[1]) {
      const body = await readJson(request, 3_000_000);
      const workspace = store.publishWorkspaceHistory(
        workspaceHistoryMatch[1],
        bearerToken(request),
        {
          threadId: requiredString(body.threadId, "threadId", 120),
          history: parseHistory(body.history),
        },
      );
      broadcast(workspaceHistoryMatch[1], "workspace.updated", {
        selectedThreadId: workspace.selectedThreadId,
        syncedAt: workspace.syncedAt,
        historyCount: workspace.history.length,
      });
      sendJson(response, 200, { workspace });
      return;
    }

    const workspaceSnapshotMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/snapshot$/,
    );
    if (method === "PUT" && workspaceSnapshotMatch?.[1]) {
      const body = await readJson(request, 9_000_000);
      const workspace = store.publishWorkspaceSnapshot(
        workspaceSnapshotMatch[1],
        bearerToken(request),
        {
          threadId: requiredString(body.threadId, "threadId", 120),
          history: parseHistory(body.history),
          files: parseWorkspaceFiles(body.files),
        },
      );
      broadcast(workspaceSnapshotMatch[1], "workspace.updated", {
        selectedThreadId: workspace.selectedThreadId,
        syncedAt: workspace.syncedAt,
      });
      sendJson(response, 200, { workspace });
      return;
    }

    const workspaceFileOperationClaimMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/file-operations\/claim$/,
    );
    if (method === "POST" && workspaceFileOperationClaimMatch?.[1]) {
      await readJson(request, 4_096);
      const result = store.claimNextWorkspaceFileOperation(
        workspaceFileOperationClaimMatch[1],
        bearerToken(request),
      );
      for (const rejected of result.rejected) {
        broadcast(
          workspaceFileOperationClaimMatch[1],
          "file.operation.updated",
          toWorkspaceFileOperationEvent(rejected),
        );
      }
      if (result.operation) {
        broadcast(
          workspaceFileOperationClaimMatch[1],
          "file.operation.updated",
          toWorkspaceFileOperationEvent(result.operation),
        );
      }
      sendJson(response, 200, { operation: result.operation });
      return;
    }

    const workspaceFileOperationResultMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/file-operations\/([^/]+)\/result$/,
    );
    if (
      method === "PATCH" &&
      workspaceFileOperationResultMatch?.[1] &&
      workspaceFileOperationResultMatch[2]
    ) {
      const body = await readJson(request, 2_100_000);
      let input:
        | { status: "completed"; leaseId: string; file: WorkspaceFileContent }
        | {
            status: "failed";
            leaseId: string;
            errorCode: string;
            errorMessage: string;
            file?: WorkspaceFileContent | null;
          };
      if (body.status === "completed") {
        input = {
          status: "completed",
          leaseId: requiredString(body.leaseId, "leaseId", 100),
          file: parseWorkspaceOperationResultFile(body.file),
        };
      } else if (body.status === "failed") {
        input = {
          status: "failed",
          leaseId: requiredString(body.leaseId, "leaseId", 100),
          errorCode: requiredString(body.errorCode, "errorCode", 120),
          errorMessage: requiredString(body.errorMessage, "errorMessage", 1_000),
          ...(body.file === undefined || body.file === null
            ? {}
            : { file: parseWorkspaceOperationResultFile(body.file) }),
        };
      } else {
        throw new ProtocolError(
          400,
          "invalid_request",
          "status must be completed or failed",
        );
      }
      const operation = store.completeWorkspaceFileOperation(
        workspaceFileOperationResultMatch[1],
        bearerToken(request),
        workspaceFileOperationResultMatch[2],
        input,
      );
      broadcast(
        workspaceFileOperationResultMatch[1],
        "file.operation.updated",
        toWorkspaceFileOperationEvent(operation),
      );
      if (operation.resultFile) {
        broadcast(workspaceFileOperationResultMatch[1], "workspace.updated", {
          path: operation.resultFile.path,
          sha256: operation.resultFile.sha256,
          modifiedAt: operation.resultFile.modifiedAt,
        });
      }
      sendJson(response, 200, { operation });
      return;
    }

    const workspaceFileOperationMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/file-operations\/([^/]+)$/,
    );
    if (
      method === "GET" &&
      workspaceFileOperationMatch?.[1] &&
      workspaceFileOperationMatch[2]
    ) {
      sendJson(response, 200, {
        operation: store.getWorkspaceFileOperation(
          workspaceFileOperationMatch[1],
          bearerToken(request),
          workspaceFileOperationMatch[2],
        ),
      });
      return;
    }

    const workspaceFileOperationsMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/file-operations$/,
    );
    if (workspaceFileOperationsMatch?.[1] && method === "GET") {
      const rawLimit = url.searchParams.get("limit");
      const limit = optionalInteger(
        rawLimit === null ? undefined : Number(rawLimit),
        100,
        "limit",
        1,
        200,
      );
      sendJson(response, 200, {
        operations: store.listWorkspaceFileOperations(
          workspaceFileOperationsMatch[1],
          bearerToken(request),
          limit,
        ),
      });
      return;
    }
    if (workspaceFileOperationsMatch?.[1] && method === "POST") {
      enforceRateLimit(request, "workspace-file-operation", 120, 60_000);
      const body = await readJson(request, 2_100_000);
      const operation = store.createWorkspaceFileOperation(
        workspaceFileOperationsMatch[1],
        bearerToken(request),
        parseWorkspaceFileOperationRequest(body),
      );
      broadcast(
        workspaceFileOperationsMatch[1],
        "file.operation.updated",
        toWorkspaceFileOperationEvent(operation),
      );
      sendJson(response, 202, { operation });
      return;
    }

    const workspaceFileMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/file$/,
    );
    if (method === "GET" && workspaceFileMatch?.[1]) {
      const path = url.searchParams.get("path");
      sendJson(response, 200, {
        file: store.getWorkspaceFile(
          workspaceFileMatch[1],
          bearerToken(request),
          requiredString(path, "path", 500),
        ),
      });
      return;
    }

    sendJson(response, 404, {
      error: { code: "not_found", message: "Route was not found" },
    });
  } catch (error) {
    sendError(response, error);
  }
});

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/v1/realtime") {
      rejectUpgrade(socket, 404);
      return;
    }
    if (request.headers.origin) {
      const expectedOrigin = configuredPasskeyOrigin
        ? new URL(configuredPasskeyOrigin).origin
        : `http://${request.headers.host ?? "localhost"}`;
      if (request.headers.origin !== expectedOrigin) {
        rejectUpgrade(socket, 403);
        return;
      }
    }
    const ticket = url.searchParams.get("ticket");
    let identity: RealtimeTicketIdentity;
    if (ticket) {
      identity = realtimeTickets.consume(ticket);
    } else {
      const sessionId = url.searchParams.get("sessionId");
      const token = url.searchParams.get("token");
      if (!allowLegacyRealtimeTokens || !sessionId || !token) {
        rejectUpgrade(socket, 401);
        return;
      }
      identity = {
        sessionId,
        member: store.authenticateRealtime(sessionId, token),
        accountSessionId: store.accountSessionForMemberToken(sessionId, token),
        session: store.getSession(sessionId),
      };
    }
    const { sessionId, member, accountSessionId, session } = identity;
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      let alive = true;
      const set = socketsBySession.get(sessionId) ?? new Set<WebSocket>();
      set.add(webSocket);
      socketsBySession.set(sessionId, set);
      if (accountSessionId) {
        const accountSockets =
          socketsByAccountSession.get(accountSessionId) ?? new Set<WebSocket>();
        accountSockets.add(webSocket);
        socketsByAccountSession.set(accountSessionId, accountSockets);
      }
      webSocket.send(
        JSON.stringify({
          type: "ready",
          sessionId,
          payload: { member, session },
          sentAt: new Date().toISOString(),
        } satisfies RealtimeEnvelope),
      );
      webSocket.on("pong", () => {
        alive = true;
      });
      webSocket.on("error", () => {
        webSocket.terminate();
      });
      webSocket.on("close", () => {
        set.delete(webSocket);
        if (set.size === 0) {
          socketsBySession.delete(sessionId);
        }
        if (accountSessionId) {
          const accountSockets = socketsByAccountSession.get(accountSessionId);
          accountSockets?.delete(webSocket);
          if (accountSockets?.size === 0) {
            socketsByAccountSession.delete(accountSessionId);
          }
        }
      });
      const heartbeat = setInterval(() => {
        if (!alive) {
          webSocket.terminate();
          return;
        }
        alive = false;
        webSocket.ping();
      }, 30_000);
      heartbeat.unref();
      webSocket.once("close", () => clearInterval(heartbeat));
    });
  } catch (error) {
    const statusCode =
      error instanceof ProtocolError &&
      (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404)
        ? error.statusCode
        : 401;
    rejectUpgrade(socket, statusCode);
  }
});

server.listen(port, host, () => {
  console.log(`Codex Collab relay listening on http://${host}:${port}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, stopping relay`);
  webSockets.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
