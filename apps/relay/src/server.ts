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
import {
  ProtocolError,
  type RealtimeEnvelope,
} from "@codex-collab/protocol";
import {
  AccountAuthService,
  resolvePasskeyConfig,
  type PasskeyRequestConfig,
} from "./accounts/account-auth.js";
import { SessionStore, type AccountSessionIdentity } from "./application/session-store.js";
import {
  RealtimeTicketStore,
  type RealtimeTicketIdentity,
} from "./realtime/realtime-tickets.js";
import { handleAccountRoutes } from "./routes/account-routes.js";
import { handleMessageRoutes } from "./routes/message-routes.js";
import type { RelayRouteContext } from "./routes/route-context.js";
import { handleSessionRoutes } from "./routes/session-routes.js";
import { handleWorkspaceFileRoutes } from "./routes/workspace-file-routes.js";
import { handleWorkspaceSyncRoutes } from "./routes/workspace-sync-routes.js";

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

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new ProtocolError(401, "unauthorized", "Bearer token is required");
  }
  return authorization.slice("Bearer ".length).trim();
}

function prefersMinimalResponse(request: IncomingMessage): boolean {
  const prefer = request.headers.prefer;
  const values = Array.isArray(prefer) ? prefer : prefer ? [prefer] : [];
  return values
    .flatMap((value) => value.split(","))
    .some((value) => value.trim().toLowerCase() === "return=minimal");
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

const routeContext: RelayRouteContext = {
  store,
  accountAuth,
  realtimeTickets,
  configuredPublicUrl,
  host,
  port,
  trustProxy,
  sendJson,
  sendAttachment,
  readJson,
  bearerToken,
  prefersMinimalResponse,
  passkeyConfig,
  cookieName,
  cookieValue,
  setCookie,
  clearCookie,
  assertAccountRequestOrigin,
  enforceRateLimit,
  optionalAccountForWrite,
  requireAccountForWrite,
  requireCsrfToken,
  optionalConfiguredAccountForWrite,
  broadcast,
  closeAccountSessionSockets,
};

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

    if (await handleAccountRoutes(request, response, url, method, routeContext)) return;
    if (await handleSessionRoutes(request, response, url, method, routeContext)) return;
    if (await handleMessageRoutes(request, response, url, method, routeContext)) return;
    if (await handleWorkspaceSyncRoutes(request, response, url, method, routeContext)) return;
    if (await handleWorkspaceFileRoutes(request, response, url, method, routeContext)) return;

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
