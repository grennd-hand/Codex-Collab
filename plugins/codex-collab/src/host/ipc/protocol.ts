export const HOST_IPC_PROTOCOL_VERSION = 1 as const;
export const HOST_IPC_UNAUTHENTICATED_FRAME_LIMIT = 8 * 1024;
export const HOST_IPC_AUTHENTICATED_FRAME_LIMIT = 16 * 1024 * 1024;
export const HOST_IPC_AUTH_TIMEOUT_MS = 2_000;
export const HOST_IPC_MAX_REQUEST_TIMEOUT_MS = 120_000;

export const HOST_TOOL_METHODS = [
  "collab_health",
  "collab_create_session",
  "collab_recover_session",
  "collab_create_invite",
  "collab_pair_host",
  "collab_refresh_workspace",
  "collab_join_session",
  "collab_status",
  "collab_list_members",
  "collab_approve_member",
  "collab_send_message",
  "collab_list_messages",
  "collab_bind_thread",
  "collab_list_codex_threads",
  "collab_forward_prompt",
  "collab_list_files",
  "collab_read_file",
  "collab_write_file",
] as const;

export type HostToolMethod = (typeof HOST_TOOL_METHODS)[number];
export type HostRuntimePhase =
  | "unpaired"
  | "active"
  | "draining"
  | "suspended"
  | "catching-up"
  | "failed";
export type HostIpcClientKind = "mcp" | "desktop";
export type HostIpcMethod = HostToolMethod | "host.status" | "host.gracefulStop";
export type HostIpcArguments = Record<string, unknown>;

export interface HostIpcHelloV1 {
  v: typeof HOST_IPC_PROTOCOL_VERSION;
  type: "auth.hello";
  clientKind: HostIpcClientKind;
  keyId: string;
  clientNonce: string;
  issuedAt: number;
}

export interface HostIpcChallengeV1 {
  v: typeof HOST_IPC_PROTOCOL_VERSION;
  type: "auth.challenge";
  clientKind: HostIpcClientKind;
  keyId: string;
  clientNonce: string;
  serverNonce: string;
  expiresAt: number;
  serverProof: string;
}

export interface HostIpcProofV1 {
  v: typeof HOST_IPC_PROTOCOL_VERSION;
  type: "auth.proof";
  clientNonce: string;
  serverNonce: string;
  clientProof: string;
}

export interface HostIpcReadyV1 {
  v: typeof HOST_IPC_PROTOCOL_VERSION;
  type: "auth.ready";
  sessionId: string;
}

export interface HostIpcRequestV1 {
  v: typeof HOST_IPC_PROTOCOL_VERSION;
  type: "request";
  id: string;
  method: HostIpcMethod;
  params: HostIpcArguments;
  sentAt: number;
  timeoutMs: number;
}

export interface HostIpcErrorV1 {
  code:
    | "invalid_request"
    | "method_not_allowed"
    | "forbidden"
    | "request_replayed"
    | "request_timeout"
    | "host_error";
  message: string;
}

export type HostIpcResponseV1 =
  | {
      v: typeof HOST_IPC_PROTOCOL_VERSION;
      type: "response";
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      v: typeof HOST_IPC_PROTOCOL_VERSION;
      type: "response";
      id: string;
      ok: false;
      error: HostIpcErrorV1;
    };

export interface HostIpcStatusV1 {
  phase: HostRuntimePhase;
  paired: boolean;
  acceptingWork: boolean;
  since: string;
  detail?: string;
}

export interface AuthenticatedHostIpcPeer {
  clientKind: HostIpcClientKind;
  keyId: string;
  sessionId: string;
  authenticatedAt: number;
}

const hostToolMethodSet: ReadonlySet<string> = new Set(HOST_TOOL_METHODS);
const hostMethodSet: ReadonlySet<string> = new Set([
  ...HOST_TOOL_METHODS,
  "host.status",
  "host.gracefulStop",
]);
const errorCodeSet: ReadonlySet<string> = new Set([
  "invalid_request",
  "method_not_allowed",
  "forbidden",
  "request_replayed",
  "request_timeout",
  "host_error",
]);
const noncePattern = /^[A-Za-z0-9_-]{43}$/;
const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export class HostIpcProtocolError extends Error {
  constructor(
    message: string,
    readonly code: HostIpcErrorV1["code"] = "invalid_request",
  ) {
    super(message);
    this.name = "HostIpcProtocolError";
  }
}

export function isHostToolMethod(value: string): value is HostToolMethod {
  return hostToolMethodSet.has(value);
}

export function parseHostIpcHello(value: unknown): HostIpcHelloV1 {
  const frame = frameRecord(value, "auth.hello");
  assertOnlyKeys(frame, ["v", "type", "clientKind", "keyId", "clientNonce", "issuedAt"]);
  if (frame.clientKind !== "mcp" && frame.clientKind !== "desktop") {
    throw new HostIpcProtocolError("clientKind must be mcp or desktop");
  }
  const keyId = identifier(frame.keyId, "keyId");
  const clientNonce = nonce(frame.clientNonce, "clientNonce");
  const issuedAt = timestamp(frame.issuedAt, "issuedAt");
  return { v: 1, type: "auth.hello", clientKind: frame.clientKind, keyId, clientNonce, issuedAt };
}

export function parseHostIpcChallenge(value: unknown): HostIpcChallengeV1 {
  const frame = frameRecord(value, "auth.challenge");
  assertOnlyKeys(frame, [
    "v", "type", "clientKind", "keyId", "clientNonce", "serverNonce", "expiresAt", "serverProof",
  ]);
  if (frame.clientKind !== "mcp" && frame.clientKind !== "desktop") {
    throw new HostIpcProtocolError("clientKind must be mcp or desktop");
  }
  return {
    v: 1,
    type: "auth.challenge",
    clientKind: frame.clientKind,
    keyId: identifier(frame.keyId, "keyId"),
    clientNonce: nonce(frame.clientNonce, "clientNonce"),
    serverNonce: nonce(frame.serverNonce, "serverNonce"),
    expiresAt: timestamp(frame.expiresAt, "expiresAt"),
    serverProof: digest(frame.serverProof, "serverProof"),
  };
}

export function parseHostIpcProof(value: unknown): HostIpcProofV1 {
  const frame = frameRecord(value, "auth.proof");
  assertOnlyKeys(frame, ["v", "type", "clientNonce", "serverNonce", "clientProof"]);
  return {
    v: 1,
    type: "auth.proof",
    clientNonce: nonce(frame.clientNonce, "clientNonce"),
    serverNonce: nonce(frame.serverNonce, "serverNonce"),
    clientProof: digest(frame.clientProof, "clientProof"),
  };
}

export function parseHostIpcReady(value: unknown): HostIpcReadyV1 {
  const frame = frameRecord(value, "auth.ready");
  assertOnlyKeys(frame, ["v", "type", "sessionId"]);
  return { v: 1, type: "auth.ready", sessionId: identifier(frame.sessionId, "sessionId") };
}

export function parseHostIpcRequest(value: unknown): HostIpcRequestV1 {
  const frame = frameRecord(value, "request");
  assertOnlyKeys(frame, ["v", "type", "id", "method", "params", "sentAt", "timeoutMs"]);
  if (typeof frame.method !== "string" || !hostMethodSet.has(frame.method)) {
    throw new HostIpcProtocolError("IPC method is not allowlisted", "method_not_allowed");
  }
  if (!isRecord(frame.params)) throw new HostIpcProtocolError("params must be an object");
  const timeoutMs = frame.timeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    (timeoutMs as number) < 1 ||
    (timeoutMs as number) > HOST_IPC_MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new HostIpcProtocolError(
      `timeoutMs must be between 1 and ${HOST_IPC_MAX_REQUEST_TIMEOUT_MS}`,
    );
  }
  return {
    v: 1,
    type: "request",
    id: identifier(frame.id, "request id"),
    method: frame.method as HostIpcMethod,
    params: frame.params,
    sentAt: timestamp(frame.sentAt, "sentAt"),
    timeoutMs: timeoutMs as number,
  };
}

export function parseHostIpcResponse(value: unknown): HostIpcResponseV1 {
  const frame = frameRecord(value, "response");
  const id = identifier(frame.id, "request id");
  if (frame.ok === true) {
    assertOnlyKeys(frame, ["v", "type", "id", "ok", "result"]);
    if (!("result" in frame)) throw new HostIpcProtocolError("IPC response result is missing");
    return { v: 1, type: "response", id, ok: true, result: frame.result };
  }
  if (frame.ok !== false) throw new HostIpcProtocolError("IPC response ok must be boolean");
  assertOnlyKeys(frame, ["v", "type", "id", "ok", "error"]);
  if (!isRecord(frame.error)) throw new HostIpcProtocolError("IPC response error is invalid");
  assertOnlyKeys(frame.error, ["code", "message"]);
  if (typeof frame.error.code !== "string" || !errorCodeSet.has(frame.error.code)) {
    throw new HostIpcProtocolError("IPC response error code is invalid");
  }
  if (typeof frame.error.message !== "string" || frame.error.message.length === 0) {
    throw new HostIpcProtocolError("IPC response error message is invalid");
  }
  return {
    v: 1,
    type: "response",
    id,
    ok: false,
    error: {
      code: frame.error.code as HostIpcErrorV1["code"],
      message: frame.error.message,
    },
  };
}

function frameRecord(value: unknown, type: string): Record<string, unknown> {
  if (!isRecord(value)) throw new HostIpcProtocolError("IPC frame must be an object");
  if (value.v !== HOST_IPC_PROTOCOL_VERSION) {
    throw new HostIpcProtocolError(`Unsupported IPC protocol version: ${String(value.v)}`);
  }
  if (value.type !== type) throw new HostIpcProtocolError(`Expected ${type} frame`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new HostIpcProtocolError("IPC frame contains unsupported fields");
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new HostIpcProtocolError(`${label} is invalid`);
  }
  return value;
}

function nonce(value: unknown, label: string): string {
  if (typeof value !== "string" || !noncePattern.test(value)) {
    throw new HostIpcProtocolError(`${label} must be a 32-byte base64url nonce`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !noncePattern.test(value)) {
    throw new HostIpcProtocolError(`${label} must be a SHA-256 base64url digest`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HostIpcProtocolError(`${label} must be a millisecond timestamp`);
  }
  return value as number;
}
