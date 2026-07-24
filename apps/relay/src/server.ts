import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  optionalInteger,
  ProtocolError,
  requiredString,
  type MessageKind,
  type RealtimeEnvelope,
} from "@codex-collab/protocol";
import { buildInviteLink, resolveInviteOrigin } from "./invite-link.js";
import { SessionStore } from "./session-store.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const relayRoot = join(moduleDir, "..");
const publicRoot = join(relayRoot, "public");
const dataDir = process.env.CODEX_COLLAB_DATA_DIR ?? join(relayRoot, ".data");
const databasePath = process.env.CODEX_COLLAB_DATABASE ?? join(dataDir, "relay.sqlite");
const port = Number.parseInt(process.env.PORT ?? "4177", 10);
const host = process.env.HOST ?? "127.0.0.1";
const configuredPublicUrl = process.env.CODEX_COLLAB_PUBLIC_URL;
const trustProxy = process.env.CODEX_COLLAB_TRUST_PROXY === "1";

mkdirSync(dataDir, { recursive: true });
const store = new SessionStore(databasePath);
const socketsBySession = new Map<string, Set<WebSocket>>();
const webSockets = new WebSocketServer({ noServer: true });

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
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

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) {
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
      socket.send(data);
    }
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

    if (method === "POST" && url.pathname === "/v1/sessions") {
      const body = await readJson(request);
      const result = store.createSession(
        requiredString(body.name, "name", 120),
        requiredString(body.ownerDisplayName, "ownerDisplayName", 80),
        typeof body.deviceLabel === "string" ? body.deviceLabel.slice(0, 120) : undefined,
      );
      sendJson(response, 201, result);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/invites/join") {
      const body = await readJson(request);
      const result = store.joinInvite(
        requiredString(body.inviteToken, "inviteToken", 200),
        requiredString(body.displayName, "displayName", 80),
        typeof body.deviceLabel === "string" ? body.deviceLabel.slice(0, 120) : undefined,
      );
      broadcast(result.session.id, "member.updated", result.member);
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

    const meMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/me$/);
    if (method === "GET" && meMatch?.[1]) {
      sendJson(response, 200, {
        member: store.getCurrentMember(meMatch[1], bearerToken(request)),
      });
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

    const messagesMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
    if (messagesMatch?.[1] && method === "GET") {
      const after = url.searchParams.get("after") ?? undefined;
      sendJson(response, 200, {
        messages: store.listMessages(messagesMatch[1], bearerToken(request), after),
      });
      return;
    }
    if (messagesMatch?.[1] && method === "POST") {
      const body = await readJson(request);
      const kind = body.kind ?? "chat";
      if (kind !== "chat" && kind !== "codex_prompt") {
        throw new ProtocolError(400, "invalid_request", "kind must be chat or codex_prompt");
      }
      const message = store.addMessage(
        messagesMatch[1],
        bearerToken(request),
        kind as MessageKind,
        requiredString(body.body, "body", 50_000),
      );
      broadcast(messagesMatch[1], "message.created", message);
      sendJson(response, 201, { message });
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
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get("sessionId");
    const token = url.searchParams.get("token");
    if (!sessionId || !token) {
      socket.destroy();
      return;
    }
    const member = store.authenticateRealtime(sessionId, token);
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      const set = socketsBySession.get(sessionId) ?? new Set<WebSocket>();
      set.add(webSocket);
      socketsBySession.set(sessionId, set);
      webSocket.send(
        JSON.stringify({
          type: "ready",
          sessionId,
          payload: { member },
          sentAt: new Date().toISOString(),
        } satisfies RealtimeEnvelope),
      );
      webSocket.on("close", () => {
        set.delete(webSocket);
        if (set.size === 0) {
          socketsBySession.delete(sessionId);
        }
      });
    });
  } catch {
    socket.destroy();
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
