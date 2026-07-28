import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  HOST_IPC_AUTH_TIMEOUT_MS,
  HOST_IPC_PROTOCOL_VERSION,
  type AuthenticatedHostIpcPeer,
  type HostIpcChallengeV1,
  type HostIpcClientKind,
  type HostIpcHelloV1,
  type HostIpcProofV1,
  HostIpcProtocolError,
  type HostIpcReadyV1,
  parseHostIpcChallenge,
  parseHostIpcHello,
  parseHostIpcProof,
  parseHostIpcReady,
} from "./protocol.js";

export interface HostIpcCapability {
  keyId: string;
  clientKind: HostIpcClientKind;
  secret: Uint8Array;
}

interface PendingChallenge {
  connectionId: string;
  capability: HostIpcCapability;
  hello: HostIpcHelloV1;
  challenge: HostIpcChallengeV1;
}

export class HostIpcServerAuthenticator {
  private readonly pending = new Map<string, PendingChallenge>();
  private readonly seenClientNonces = new Map<string, number>();

  constructor(
    private readonly resolveCapability: (
      keyId: string,
    ) => HostIpcCapability | undefined,
    private readonly now: () => number = Date.now,
    private readonly random: (size: number) => Buffer = randomBytes,
  ) {}

  begin(connectionId: string, value: unknown): HostIpcChallengeV1 {
    assertConnectionId(connectionId);
    const hello = parseHostIpcHello(value);
    const now = this.now();
    this.purge(now);
    if (Math.abs(now - hello.issuedAt) > HOST_IPC_AUTH_TIMEOUT_MS) {
      throw new HostIpcProtocolError("Authentication hello expired", "request_timeout");
    }
    const replayKey = `${hello.keyId}:${hello.clientNonce}`;
    if (this.seenClientNonces.has(replayKey)) {
      throw new HostIpcProtocolError("Authentication nonce was already used", "request_replayed");
    }
    const capability = this.resolveCapability(hello.keyId);
    if (!capability || capability.clientKind !== hello.clientKind) {
      throw new HostIpcProtocolError("Authentication capability was rejected", "forbidden");
    }
    assertCapability(capability);
    const serverNonce = nonce(this.random);
    const expiresAt = now + HOST_IPC_AUTH_TIMEOUT_MS;
    const challengeWithoutProof = {
      v: HOST_IPC_PROTOCOL_VERSION,
      type: "auth.challenge" as const,
      clientKind: hello.clientKind,
      keyId: hello.keyId,
      clientNonce: hello.clientNonce,
      serverNonce,
      expiresAt,
    };
    const challenge: HostIpcChallengeV1 = {
      ...challengeWithoutProof,
      serverProof: proof(capability.secret, "server", challengeWithoutProof),
    };
    this.seenClientNonces.set(replayKey, expiresAt + HOST_IPC_AUTH_TIMEOUT_MS);
    this.pending.set(challengeKey(connectionId, hello.clientNonce, serverNonce), {
      connectionId,
      capability,
      hello,
      challenge,
    });
    return challenge;
  }

  complete(
    connectionId: string,
    value: unknown,
  ): { peer: AuthenticatedHostIpcPeer; ready: HostIpcReadyV1 } {
    assertConnectionId(connectionId);
    const clientProof = parseHostIpcProof(value);
    const now = this.now();
    const key = challengeKey(connectionId, clientProof.clientNonce, clientProof.serverNonce);
    const pending = this.pending.get(key);
    this.pending.delete(key);
    this.purge(now);
    if (!pending) {
      throw new HostIpcProtocolError("Authentication challenge is missing or expired", "forbidden");
    }
    if (now > pending.challenge.expiresAt) {
      throw new HostIpcProtocolError("Authentication challenge expired", "request_timeout");
    }
    const expected = proof(pending.capability.secret, "client", transcript(pending.challenge));
    if (!safeDigestEqual(expected, clientProof.clientProof)) {
      throw new HostIpcProtocolError("Authentication proof was rejected", "forbidden");
    }
    const sessionId = nonce(this.random);
    return {
      peer: {
        clientKind: pending.capability.clientKind,
        keyId: pending.capability.keyId,
        sessionId,
        authenticatedAt: now,
      },
      ready: { v: HOST_IPC_PROTOCOL_VERSION, type: "auth.ready", sessionId },
    };
  }

  private purge(now: number): void {
    for (const [key, pending] of this.pending) {
      if (pending.challenge.expiresAt < now) this.pending.delete(key);
    }
    for (const [key, expiresAt] of this.seenClientNonces) {
      if (expiresAt < now) this.seenClientNonces.delete(key);
    }
  }
}

export class HostIpcClientAuthenticator {
  private readonly clientNonce: string;
  private challenge?: HostIpcChallengeV1;

  constructor(
    private readonly capability: HostIpcCapability,
    private readonly now: () => number = Date.now,
    random: (size: number) => Buffer = randomBytes,
  ) {
    assertCapability(capability);
    this.clientNonce = nonce(random);
  }

  hello(): HostIpcHelloV1 {
    return {
      v: HOST_IPC_PROTOCOL_VERSION,
      type: "auth.hello",
      clientKind: this.capability.clientKind,
      keyId: this.capability.keyId,
      clientNonce: this.clientNonce,
      issuedAt: this.now(),
    };
  }

  answer(value: unknown): HostIpcProofV1 {
    const challenge = parseHostIpcChallenge(value);
    if (
      challenge.clientKind !== this.capability.clientKind ||
      challenge.keyId !== this.capability.keyId ||
      challenge.clientNonce !== this.clientNonce ||
      challenge.expiresAt < this.now()
    ) {
      throw new HostIpcProtocolError("Server challenge does not match this client", "forbidden");
    }
    const expected = proof(this.capability.secret, "server", transcript(challenge));
    if (!safeDigestEqual(expected, challenge.serverProof)) {
      throw new HostIpcProtocolError("Server proof was rejected", "forbidden");
    }
    this.challenge = challenge;
    return {
      v: HOST_IPC_PROTOCOL_VERSION,
      type: "auth.proof",
      clientNonce: this.clientNonce,
      serverNonce: challenge.serverNonce,
      clientProof: proof(this.capability.secret, "client", transcript(challenge)),
    };
  }

  accept(value: unknown): AuthenticatedHostIpcPeer {
    const ready = parseHostIpcReady(value);
    if (!this.challenge) {
      throw new HostIpcProtocolError("Authentication challenge was not answered", "forbidden");
    }
    return {
      clientKind: this.capability.clientKind,
      keyId: this.capability.keyId,
      sessionId: ready.sessionId,
      authenticatedAt: this.now(),
    };
  }
}

function transcript(challenge: HostIpcChallengeV1) {
  return {
    v: challenge.v,
    type: challenge.type,
    clientKind: challenge.clientKind,
    keyId: challenge.keyId,
    clientNonce: challenge.clientNonce,
    serverNonce: challenge.serverNonce,
    expiresAt: challenge.expiresAt,
  };
}

function proof(secret: Uint8Array, side: "server" | "client", value: object): string {
  return createHmac("sha256", secret)
    .update(`codex-collab-host-ipc-v1\0${side}\0${JSON.stringify(value)}`)
    .digest("base64url");
}

function safeDigestEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "base64url");
  const actualBytes = Buffer.from(actual, "base64url");
  return expectedBytes.byteLength === actualBytes.byteLength && timingSafeEqual(expectedBytes, actualBytes);
}

function nonce(random: (size: number) => Buffer): string {
  const value = random(32);
  if (value.byteLength !== 32) throw new Error("IPC nonce source must return 32 bytes");
  return value.toString("base64url");
}

function challengeKey(connectionId: string, clientNonce: string, serverNonce: string): string {
  return `${connectionId}:${clientNonce}:${serverNonce}`;
}

function assertConnectionId(connectionId: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(connectionId)) {
    throw new HostIpcProtocolError("Transport connection id is invalid");
  }
}

function assertCapability(capability: HostIpcCapability): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(capability.keyId)) {
    throw new Error("IPC capability keyId is invalid");
  }
  if (capability.secret.byteLength < 32) {
    throw new Error("IPC capability secret must contain at least 32 bytes");
  }
}
