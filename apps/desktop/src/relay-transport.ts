import type {
  CodexPromptOptions,
  CreateWorkspaceFileOperationRequest,
  MessageAttachmentInput,
} from "@codex-collab/protocol";
import type { DesktopRelayOperationV1 } from "./ipc-contract.js";

const MAX_REQUEST_BYTES = 9_000_000;

type RelayMethod = "GET" | "POST" | "PUT" | "PATCH";

export interface BuiltRelayRequest {
  operation: DesktopRelayOperationV1["operation"];
  method: RelayMethod;
  path: string;
  requiresCredential: boolean;
  body?: string;
}

const AUTHENTICATED_RENDERER_OPERATIONS = new Set<string>([
  "session.me.get",
  "session.messages.list",
  "session.messages.create",
  "session.members.list",
  "session.members.approve",
  "session.members.workspace-access.update",
  "session.invites.create",
  "session.room-status.update",
  "session.host-pairings.create",
  "workspace.overview.get",
  "workspace.history-page.get",
  "workspace.selection.update",
  "workspace.file.get",
  "workspace.file-operation.create",
  "workspace.file-operation.get",
]);

export class RelayTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "RelayTransportError";
  }
}

export function record(value: unknown, code = "invalid_desktop_request"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayTransportError(code, "The desktop request is invalid.");
  }
  return value as Record<string, unknown>;
}

export function stringValue(
  value: unknown,
  field: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && value.trim().length < 1)
  ) {
    throw new RelayTransportError("invalid_desktop_request", `${field} is invalid.`);
  }
  return value;
}

function integerValue(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RelayTransportError("invalid_desktop_request", `${field} is invalid.`);
  }
  return value as number;
}

export function exactSession(
  operation: Record<string, unknown>,
  credentialSessionId: string | null,
): string {
  if (!credentialSessionId) {
    throw new RelayTransportError("credential_required", "Owner authentication is required.", 401);
  }
  const requested = stringValue(operation.sessionId, "sessionId", 100);
  if (requested !== credentialSessionId) {
    throw new RelayTransportError(
      "credential_session_mismatch",
      "The requested room does not match the saved owner session.",
      403,
    );
  }
  return credentialSessionId;
}

export function sessionPath(sessionId: string, suffix: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

function jsonBody(value: unknown): string {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new RelayTransportError("desktop_request_too_large", "The request is too large.");
  }
  return body;
}

function validateAttachments(value: unknown): MessageAttachmentInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 8) {
    throw new RelayTransportError("invalid_desktop_request", "attachments is invalid.");
  }
  return value.map((candidate) => {
    const attachment = record(candidate);
    return {
      name: stringValue(attachment.name, "attachment name", 240),
      mediaType: stringValue(attachment.mediaType, "attachment media type", 120),
      size: integerValue(attachment.size, "attachment size", 0, 4_000_000),
      dataBase64: stringValue(attachment.dataBase64, "attachment data", 5_400_000, true),
    };
  });
}

function validateCodexOptions(value: unknown): CodexPromptOptions | undefined {
  if (value === undefined) return undefined;
  return record(value) as unknown as CodexPromptOptions;
}

function validateMessageInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  const kind = input.kind ?? "chat";
  if (kind !== "chat" && kind !== "codex_prompt" && kind !== "codex_stop") {
    throw new RelayTransportError("invalid_desktop_request", "Message kind is invalid.");
  }
  const body = stringValue(input.body, "body", 50_000);
  if (kind === "codex_stop") return { kind, body };
  const attachments = validateAttachments(input.attachments);
  if (kind === "chat") return { kind, body, ...(attachments ? { attachments } : {}) };
  return {
    kind,
    body,
    ...(attachments ? { attachments } : {}),
    ...(validateCodexOptions(input.codexOptions)
      ? { codexOptions: validateCodexOptions(input.codexOptions) }
      : {}),
    expectedWorkspaceThreadId: stringValue(
      input.expectedWorkspaceThreadId,
      "expectedWorkspaceThreadId",
      120,
    ),
  };
}

function validateFileOperation(value: unknown): CreateWorkspaceFileOperationRequest {
  const input = record(value);
  const path = stringValue(input.path, "path", 500);
  if (input.kind === "read" || input.kind === "mkdir") {
    return { kind: input.kind, path };
  }
  if (input.kind === "write") {
    return {
      kind: input.kind,
      path,
      content: stringValue(input.content, "content", 2_000_000, true),
      expectedSha256: stringValue(input.expectedSha256, "expectedSha256", 64, true),
    };
  }
  if (input.kind === "rename") {
    return {
      kind: input.kind,
      path,
      destinationPath: stringValue(input.destinationPath, "destinationPath", 500),
      expectedSha256:
        input.expectedSha256 === null
          ? null
          : stringValue(input.expectedSha256, "expectedSha256", 64),
    };
  }
  throw new RelayTransportError("invalid_desktop_request", "File operation kind is invalid.");
}

function unauthenticatedRelayRequest(
  operationName: DesktopRelayOperationV1["operation"],
  operation: Record<string, unknown>,
): BuiltRelayRequest | null {
  const input = () => record(operation.input);
  switch (operationName) {
    case "health.get":
      return { operation: operationName, method: "GET", path: "/health", requiresCredential: false };
    case "session.create": {
      const body = input();
      return {
        operation: operationName,
        method: "POST",
        path: "/v1/sessions",
        requiresCredential: false,
        body: jsonBody({
          name: stringValue(body.name, "name", 120),
          ownerDisplayName: stringValue(body.ownerDisplayName, "ownerDisplayName", 80),
          ...(body.deviceLabel === undefined
            ? {}
            : { deviceLabel: stringValue(body.deviceLabel, "deviceLabel", 120) }),
        }),
      };
    }
    case "session.recover": {
      const body = input();
      return {
        operation: operationName,
        method: "POST",
        path: "/v1/sessions/recover",
        requiresCredential: false,
        body: jsonBody({
          sessionId: stringValue(body.sessionId, "sessionId", 100),
          recoveryKey: stringValue(body.recoveryKey, "recoveryKey", 200),
          ...(body.deviceLabel === undefined
            ? {}
            : { deviceLabel: stringValue(body.deviceLabel, "deviceLabel", 120) }),
        }),
      };
    }
    case "invite.join": {
      const body = input();
      return {
        operation: operationName,
        method: "POST",
        path: "/v1/invites/join",
        requiresCredential: false,
        body: jsonBody({
          inviteToken: stringValue(body.inviteToken, "inviteToken", 200),
          displayName: stringValue(body.displayName, "displayName", 80),
          ...(body.deviceLabel === undefined
            ? {}
            : { deviceLabel: stringValue(body.deviceLabel, "deviceLabel", 120) }),
        }),
      };
    }
    default:
      return null;
  }
}

function sessionRelayRequest(
  operationName: DesktopRelayOperationV1["operation"],
  operation: Record<string, unknown>,
  sessionId: string,
): BuiltRelayRequest | null {
  const input = () => record(operation.input);
  switch (operationName) {
    case "session.me.get":
      return { operation: operationName, method: "GET", path: sessionPath(sessionId, "/me"), requiresCredential: true };
    case "session.messages.list":
      return { operation: operationName, method: "GET", path: sessionPath(sessionId, "/messages"), requiresCredential: true };
    case "session.messages.create":
      return {
        operation: operationName,
        method: "POST",
        path: sessionPath(sessionId, "/messages"),
        requiresCredential: true,
        body: jsonBody(validateMessageInput(operation.input)),
      };
    case "session.members.list":
      return { operation: operationName, method: "GET", path: sessionPath(sessionId, "/members"), requiresCredential: true };
    case "session.members.approve":
      return {
        operation: operationName,
        method: "POST",
        path: sessionPath(sessionId, `/members/${encodeURIComponent(stringValue(operation.memberId, "memberId", 100))}/approve`),
        requiresCredential: true,
        body: "{}",
      };
    case "session.members.workspace-access.update": {
      const body = input();
      if (body.workspaceFileAccess !== "read-only" && body.workspaceFileAccess !== "workspace-write") {
        throw new RelayTransportError("invalid_desktop_request", "workspaceFileAccess is invalid.");
      }
      return {
        operation: operationName,
        method: "PATCH",
        path: sessionPath(sessionId, `/members/${encodeURIComponent(stringValue(operation.memberId, "memberId", 100))}/workspace-file-access`),
        requiresCredential: true,
        body: jsonBody({ workspaceFileAccess: body.workspaceFileAccess }),
      };
    }
    case "session.invites.create": {
      const body = input();
      return {
        operation: operationName,
        method: "POST",
        path: sessionPath(sessionId, "/invites"),
        requiresCredential: true,
        body: jsonBody({
          ...(body.expiresInMinutes === undefined ? {} : { expiresInMinutes: integerValue(body.expiresInMinutes, "expiresInMinutes", 5, 10_080) }),
          ...(body.maxUses === undefined ? {} : { maxUses: integerValue(body.maxUses, "maxUses", 1, 20) }),
        }),
      };
    }
    case "session.room-status.update": {
      const body = input();
      if (body.roomStatus !== "open" && body.roomStatus !== "closed") {
        throw new RelayTransportError("invalid_desktop_request", "roomStatus is invalid.");
      }
      return { operation: operationName, method: "PUT", path: sessionPath(sessionId, "/room-status"), requiresCredential: true, body: jsonBody({ roomStatus: body.roomStatus }) };
    }
    case "session.host-pairings.create": {
      const body = input();
      return { operation: operationName, method: "POST", path: sessionPath(sessionId, "/host-pairings"), requiresCredential: true, body: jsonBody({ expiresInMinutes: integerValue(body.expiresInMinutes, "expiresInMinutes", 2, 30) }) };
    }
    default:
      return null;
  }
}

function workspaceRelayRequest(
  operationName: DesktopRelayOperationV1["operation"],
  operation: Record<string, unknown>,
  sessionId: string,
): BuiltRelayRequest | null {
  const input = () => record(operation.input);
  switch (operationName) {
    case "workspace.overview.get":
      return { operation: operationName, method: "GET", path: sessionPath(sessionId, "/workspace/overview"), requiresCredential: true };
    case "workspace.history-page.get": {
      const body = input();
      const query = new URLSearchParams({ limit: String(integerValue(body.limit, "limit", 1, 200)) });
      if (body.before !== undefined) query.set("before", stringValue(body.before, "before", 2_000));
      return { operation: operationName, method: "GET", path: `${sessionPath(sessionId, "/workspace/history/page")}?${query}`, requiresCredential: true };
    }
    case "workspace.selection.update": {
      const body = input();
      return { operation: operationName, method: "PUT", path: sessionPath(sessionId, "/workspace/selection"), requiresCredential: true, body: jsonBody({ threadId: stringValue(body.threadId, "threadId", 120) }) };
    }
    case "workspace.file.get": {
      const body = input();
      const query = new URLSearchParams({ path: stringValue(body.path, "path", 500) });
      return { operation: operationName, method: "GET", path: `${sessionPath(sessionId, "/workspace/file")}?${query}`, requiresCredential: true };
    }
    case "workspace.file-operation.create":
      return { operation: operationName, method: "POST", path: sessionPath(sessionId, "/workspace/file-operations"), requiresCredential: true, body: jsonBody(validateFileOperation(operation.input)) };
    case "workspace.file-operation.get":
      return { operation: operationName, method: "GET", path: sessionPath(sessionId, `/workspace/file-operations/${encodeURIComponent(stringValue(operation.operationId, "operationId", 100))}`), requiresCredential: true };
    default:
      return null;
  }
}

export function buildRelayRequest(
  value: unknown,
  credentialSessionId: string | null,
): BuiltRelayRequest {
  const operation = record(value);
  const operationName = stringValue(
    operation.operation,
    "operation",
    80,
  ) as DesktopRelayOperationV1["operation"];
  const unauthenticated = unauthenticatedRelayRequest(operationName, operation);
  if (unauthenticated) return unauthenticated;
  if (!AUTHENTICATED_RENDERER_OPERATIONS.has(operationName)) {
    throw new RelayTransportError(
      "desktop_operation_rejected",
      "This desktop operation is not allowed.",
    );
  }
  const sessionId = exactSession(operation, credentialSessionId);
  const authenticated =
    sessionRelayRequest(operationName, operation, sessionId) ??
    workspaceRelayRequest(operationName, operation, sessionId);
  if (authenticated) return authenticated;
  throw new RelayTransportError(
    "desktop_operation_rejected",
    "This desktop operation is not allowed.",
  );
}
