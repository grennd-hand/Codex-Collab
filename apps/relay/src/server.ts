import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  optionalInteger,
  ProtocolError,
  requiredString,
  type CodexAccessMode,
  type CodexPromptOptions,
  type CodexRecordEntry,
  type CodexReasoningEffort,
  type CodexRuntimeStatus,
  type CodexSpeed,
  type CodexThreadCatalogEntry,
  type MessageAttachmentInput,
  type MessageDeliveryStatus,
  type MessageKind,
  type RealtimeEnvelope,
  type RoomStatus,
  type WorkspaceFileContent,
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
  });
  response.end(Buffer.from(attachment.content));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 9_000_000) {
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
    totalLength += text.length;
    if (totalLength > 2_000_000) {
      throw new ProtocolError(413, "history_too_large", "Imported Codex history is too large");
    }
    return {
      id: requiredString(record.id, `history[${index}].id`, 160),
      role: record.role,
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

const allowedAccessModes = new Set<CodexAccessMode>([
  "follow-desktop",
  "request-approval",
  "auto",
  "full-access",
  "custom",
]);
const allowedReasoningEfforts = new Set<CodexReasoningEffort>([
  "follow-desktop",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const allowedSpeeds = new Set<CodexSpeed>([
  "follow-desktop",
  "standard",
  "fast",
]);
const allowedModels = new Set([
  "5.6 Sol",
  "5.6 Terra",
  "5.6 Luna",
  "5.5",
  "5.4",
  "5.4 Mini",
  "5.3 Codex Spark",
]);

function parseCodexOptions(value: unknown): CodexPromptOptions {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const accessMode =
    typeof record.accessMode === "string" &&
    allowedAccessModes.has(record.accessMode as CodexAccessMode)
      ? (record.accessMode as CodexAccessMode)
      : "follow-desktop";
  const reasoningEffort =
    typeof record.reasoningEffort === "string" &&
    allowedReasoningEfforts.has(record.reasoningEffort as CodexReasoningEffort)
      ? (record.reasoningEffort as CodexReasoningEffort)
      : "follow-desktop";
  const speed =
    typeof record.speed === "string" && allowedSpeeds.has(record.speed as CodexSpeed)
      ? (record.speed as CodexSpeed)
      : "follow-desktop";
  const model =
    record.model === null || record.model === undefined || record.model === ""
      ? null
      : typeof record.model === "string" && allowedModels.has(record.model)
        ? record.model
        : (() => {
            throw new ProtocolError(400, "invalid_request", "model is not supported");
          })();
  return {
    accessMode,
    model,
    reasoningEffort,
    speed,
    planMode: record.planMode === true,
  };
}

function parseMessageAttachments(value: unknown): Array<{
  name: string;
  mediaType: string;
  size: number;
  content: Uint8Array;
}> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new ProtocolError(400, "invalid_request", "attachments must contain at most 8 files");
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
      (record.size as number) > 4_000_000
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
    if (totalSize > 6_000_000) {
      throw new ProtocolError(413, "attachments_too_large", "Attachments exceed the 6 MB limit");
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

    if (method === "POST" && url.pathname === "/v1/host-pairings/claim") {
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
      if (kind !== "chat" && kind !== "codex_prompt" && kind !== "codex_stop") {
        throw new ProtocolError(
          400,
          "invalid_request",
          "kind must be chat, codex_prompt or codex_stop",
        );
      }
      const attachments = parseMessageAttachments(body.attachments);
      if (kind !== "codex_prompt" && attachments.length > 0) {
        throw new ProtocolError(
          400,
          "invalid_request",
          "attachments are supported only for Codex prompts",
        );
      }
      const message = store.addMessage(
        messagesMatch[1],
        bearerToken(request),
        kind as MessageKind,
        requiredString(body.body, "body", 50_000),
        {
          attachments,
          codexOptions: kind === "codex_prompt" ? parseCodexOptions(body.codexOptions) : null,
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

    const workspaceSnapshotMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/snapshot$/,
    );
    if (method === "PUT" && workspaceSnapshotMatch?.[1]) {
      const body = await readJson(request);
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
    const session = store.getSession(sessionId);
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      const set = socketsBySession.get(sessionId) ?? new Set<WebSocket>();
      set.add(webSocket);
      socketsBySession.set(sessionId, set);
      webSocket.send(
        JSON.stringify({
          type: "ready",
          sessionId,
          payload: { member, session },
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
