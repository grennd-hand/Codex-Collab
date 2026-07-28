import { randomBytes } from "node:crypto";
import { HostIpcClientAuthenticator, type HostIpcCapability } from "./authentication.js";
import {
  HOST_IPC_MAX_REQUEST_TIMEOUT_MS,
  HOST_IPC_PROTOCOL_VERSION,
  type AuthenticatedHostIpcPeer,
  type HostIpcArguments,
  type HostIpcMethod,
  type HostIpcProofV1,
  type HostIpcRequestV1,
  type HostIpcResponseV1,
  HostIpcProtocolError,
  parseHostIpcRequest,
  parseHostIpcResponse,
} from "./protocol.js";

const maxPendingRequests = 64;

export class HostIpcClientProtocol {
  private readonly authenticator: HostIpcClientAuthenticator;
  private peer: AuthenticatedHostIpcPeer | undefined;
  private readonly pending = new Set<string>();
  private readonly random: (size: number) => Buffer;

  constructor(
    capability: HostIpcCapability,
    private readonly now: () => number = Date.now,
    random: (size: number) => Buffer = randomBytes,
  ) {
    this.random = random;
    this.authenticator = new HostIpcClientAuthenticator(capability, now, random);
  }

  hello() {
    return this.authenticator.hello();
  }

  answerChallenge(challenge: unknown): HostIpcProofV1 {
    return this.authenticator.answer(challenge);
  }

  acceptReady(ready: unknown): AuthenticatedHostIpcPeer {
    this.peer = this.authenticator.accept(ready);
    return this.peer;
  }

  request(
    method: HostIpcMethod,
    params: HostIpcArguments,
    timeoutMs = 30_000,
  ): HostIpcRequestV1 {
    if (!this.peer) throw new HostIpcProtocolError("IPC client is not authenticated", "forbidden");
    if (this.pending.size >= maxPendingRequests) {
      throw new HostIpcProtocolError("Host IPC client has too many pending requests", "host_error");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HOST_IPC_MAX_REQUEST_TIMEOUT_MS) {
      throw new HostIpcProtocolError(
        `timeoutMs must be between 1 and ${HOST_IPC_MAX_REQUEST_TIMEOUT_MS}`,
      );
    }
    const id = this.random(16).toString("hex");
    this.pending.add(id);
    return parseHostIpcRequest({
      v: HOST_IPC_PROTOCOL_VERSION,
      type: "request",
      id,
      method,
      params,
      sentAt: this.now(),
      timeoutMs,
    });
  }

  acceptResponse(value: unknown): HostIpcResponseV1 {
    const response = parseHostIpcResponse(value);
    if (!this.pending.delete(response.id)) {
      throw new HostIpcProtocolError("IPC response id is unknown or replayed", "request_replayed");
    }
    return response;
  }

  disconnect(): void {
    this.pending.clear();
    this.peer = undefined;
  }
}
