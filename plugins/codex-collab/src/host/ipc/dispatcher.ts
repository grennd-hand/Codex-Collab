import { createHash } from "node:crypto";
import type { HostApplication } from "../host-application.js";
import {
  HOST_IPC_AUTH_TIMEOUT_MS,
  HOST_IPC_PROTOCOL_VERSION,
  type AuthenticatedHostIpcPeer,
  type HostIpcErrorV1,
  HostIpcProtocolError,
  type HostIpcRequestV1,
  type HostIpcResponseV1,
  type HostRuntimePhase,
  type HostIpcStatusV1,
  type HostToolMethod,
  isHostToolMethod,
  parseHostIpcRequest,
} from "./protocol.js";

export interface HostIpcDispatcherOptions {
  runtimePhase: () => HostRuntimePhase;
  status: () => HostIpcStatusV1 | Promise<HostIpcStatusV1>;
  gracefulStop: () => void | Promise<void>;
  now?: () => number;
}

interface RequestReceipt {
  fingerprint: string;
  response: Promise<HostIpcResponseV1>;
  expiresAt: number;
}

const maxReceipts = 64;
const maxCachedResponseBytes = 1024 * 1024;
const maxGlobalInFlight = 32;
const maxPeerInFlight = 8;
const receiptTtlMs = 5 * 60_000;
const runtimeRestrictedTools: ReadonlySet<HostToolMethod> = new Set([
  "collab_refresh_workspace",
  "collab_bind_thread",
  "collab_list_codex_threads",
  "collab_forward_prompt",
  "collab_list_files",
  "collab_read_file",
  "collab_write_file",
]);

export class HostIpcRequestDispatcher {
  private readonly receipts = new Map<string, RequestReceipt>();
  private readonly peerInFlight = new Map<string, number>();
  private globalInFlight = 0;
  private readonly now: () => number;

  constructor(
    private readonly application: Pick<HostApplication, "callTool">,
    private readonly options: HostIpcDispatcherOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async dispatch(
    peer: AuthenticatedHostIpcPeer,
    value: unknown,
  ): Promise<HostIpcResponseV1> {
    let request: HostIpcRequestV1;
    try {
      request = parseHostIpcRequest(value);
    } catch (error) {
      const id = requestIdFrom(value);
      return failure(id, protocolError(error));
    }

    const now = this.now();
    this.purge(now);
    const receiptKey = `${peer.keyId}:${request.id}`;
    const fingerprint = requestFingerprint(request);
    const existing = this.receipts.get(receiptKey);
    if (existing) {
      if (existing.fingerprint === fingerprint) return existing.response;
      return failure(request.id, {
        code: "request_replayed",
        message: "IPC request id was reused with a different operation",
      });
    }
    const expiresAt = request.sentAt + request.timeoutMs;
    if (request.sentAt > now + HOST_IPC_AUTH_TIMEOUT_MS || expiresAt < now) {
      return failure(request.id, { code: "request_timeout", message: "IPC request expired" });
    }
    const peerActive = this.peerInFlight.get(peer.keyId) ?? 0;
    if (
      this.receipts.size >= maxReceipts ||
      this.globalInFlight >= maxGlobalInFlight ||
      peerActive >= maxPeerInFlight
    ) {
      return failure(request.id, { code: "host_error", message: "Host IPC is busy" });
    }

    this.globalInFlight += 1;
    this.peerInFlight.set(peer.keyId, peerActive + 1);
    const response = this.executeWithResponse(peer, request);
    const receipt: RequestReceipt = {
      fingerprint,
      response,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    this.receipts.set(receiptKey, receipt);
    void response.then((completed) => {
      this.globalInFlight -= 1;
      const remaining = (this.peerInFlight.get(peer.keyId) ?? 1) - 1;
      if (remaining > 0) this.peerInFlight.set(peer.keyId, remaining);
      else this.peerInFlight.delete(peer.keyId);
      receipt.expiresAt = this.now() + receiptTtlMs;
      if (responseSize(completed) > maxCachedResponseBytes) this.receipts.delete(receiptKey);
    });
    return response;
  }

  private async executeWithResponse(
    peer: AuthenticatedHostIpcPeer,
    request: HostIpcRequestV1,
  ): Promise<HostIpcResponseV1> {
    try {
      // The timeout is an admission deadline. Once accepted, a file or Relay operation must
      // report its real result; returning early cannot cancel HostApplication and could make a
      // retry duplicate a side effect.
      const result = await this.execute(peer, request);
      return { v: HOST_IPC_PROTOCOL_VERSION, type: "response", id: request.id, ok: true, result };
    } catch (error) {
      return failure(request.id, protocolError(error, "host_error"));
    }
  }

  private async execute(
    peer: AuthenticatedHostIpcPeer,
    request: HostIpcRequestV1,
  ): Promise<unknown> {
    if (isHostToolMethod(request.method)) {
      if (peer.clientKind !== "mcp") {
        throw new HostIpcProtocolError(
          "Desktop clients cannot invoke MCP collaboration tools",
          "forbidden",
        );
      }
      assertRuntimeAdmission(request.method, this.options.runtimePhase());
      const admission = runtimeRestrictedTools.has(request.method)
        ? { isAllowed: () => this.options.runtimePhase() === "active" }
        : undefined;
      return admission
        ? this.application.callTool(request.method, request.params, admission)
        : this.application.callTool(request.method, request.params);
    }
    if (request.method === "host.status") {
      assertEmptyParams(request.params);
      return this.options.status();
    }
    if (request.method === "host.gracefulStop") {
      assertEmptyParams(request.params);
      if (peer.clientKind !== "desktop") {
        throw new HostIpcProtocolError(
          "Only the desktop capability may stop the Host",
          "forbidden",
        );
      }
      await this.options.gracefulStop();
      return { stopping: true };
    }
    throw new HostIpcProtocolError("IPC method is not allowlisted", "method_not_allowed");
  }

  private purge(now: number): void {
    for (const [id, receipt] of this.receipts) {
      if (receipt.expiresAt < now) this.receipts.delete(id);
    }
  }
}

function assertRuntimeAdmission(method: HostToolMethod, phase: HostRuntimePhase): void {
  if (phase === "active" || !runtimeRestrictedTools.has(method)) {
    return;
  }
  throw new HostIpcProtocolError(
    `Host runtime is ${phase}; ${method} is unavailable until the Host is active`,
    "host_error",
  );
}

function assertEmptyParams(params: Record<string, unknown>): void {
  if (Object.keys(params).length !== 0) {
    throw new HostIpcProtocolError("Host control methods do not accept parameters");
  }
}

function requestIdFrom(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string"
  ) {
    const id = (value as { id: string }).id;
    return /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : "invalid";
  }
  return "invalid";
}

function protocolError(
  error: unknown,
  fallback: HostIpcErrorV1["code"] = "invalid_request",
): HostIpcErrorV1 {
  if (error instanceof HostIpcProtocolError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: fallback,
    message: error instanceof Error ? error.message : "Host request failed",
  };
}

function failure(id: string, error: HostIpcErrorV1): HostIpcResponseV1 {
  return { v: HOST_IPC_PROTOCOL_VERSION, type: "response", id, ok: false, error };
}

function requestFingerprint(request: HostIpcRequestV1): string {
  return createHash("sha256")
    .update(request.method)
    .update("\0")
    .update(canonicalJson(request.params))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function responseSize(response: HostIpcResponseV1): number {
  try {
    return Buffer.byteLength(JSON.stringify(response));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
