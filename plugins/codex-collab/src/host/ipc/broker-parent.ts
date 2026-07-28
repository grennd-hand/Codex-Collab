import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AuthenticatedHostIpcPeer, HostIpcRequestV1, HostIpcResponseV1 } from "./protocol.js";
import {
  HOST_IPC_PROTOCOL_VERSION,
  HostIpcProtocolError,
  parseHostIpcRequest,
} from "./protocol.js";
import type { HostIpcCapability } from "./authentication.js";
import { encodeHostIpcFrame, HostIpcFrameDecoder } from "./framing.js";

export interface HostIpcBrokerReadyV1 {
  instanceId: string;
  pipePath: string;
  brokerPid: number;
  capabilities: readonly HostIpcCapability[];
}

export interface HostIpcBrokerParentOptions {
  executablePath: string;
  handleRequest: (
    peer: AuthenticatedHostIpcPeer,
    request: HostIpcRequestV1,
  ) => Promise<HostIpcResponseV1>;
  afterResponse?: (
    request: HostIpcRequestV1,
    response: HostIpcResponseV1,
  ) => void | Promise<void>;
  onUnexpectedExit?: (error: Error) => void;
  reportError?: (error: unknown) => void;
  spawnBroker?: (executablePath: string) => ChildProcessWithoutNullStreams;
}

interface BrokerRequestV1 {
  connectionId: number;
  peer: AuthenticatedHostIpcPeer;
  request: HostIpcRequestV1;
}

export class HostIpcBrokerParent {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new HostIpcFrameDecoder();
  private readonly readyPromise: Promise<HostIpcBrokerReadyV1>;
  private resolveReady!: (ready: HostIpcBrokerReadyV1) => void;
  private rejectReady!: (error: Error) => void;
  private ready = false;
  private stopping = false;
  private stopped = false;

  private constructor(private readonly options: HostIpcBrokerParentOptions) {
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.child = (options.spawnBroker ?? defaultSpawnBroker)(options.executablePath);
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) (options.reportError ?? console.error)(new Error(message));
    });
    this.child.on("error", (error) => this.handleExit(error));
    this.child.on("exit", (code, signal) => {
      this.handleExit(
        new Error(`Host IPC broker exited (${code ?? "no-code"}/${signal ?? "no-signal"})`),
      );
    });
  }

  static async start(options: HostIpcBrokerParentOptions): Promise<{
    broker: HostIpcBrokerParent;
    ready: HostIpcBrokerReadyV1;
  }> {
    const broker = new HostIpcBrokerParent(options);
    await broker.write({ v: HOST_IPC_PROTOCOL_VERSION, type: "broker.bootstrap" }, false);
    const timeout = setTimeout(() => {
      broker.rejectReady(new Error("Timed out waiting for Host IPC broker readiness"));
      void broker.stop();
    }, 5_000);
    timeout.unref?.();
    try {
      return { broker, ready: await broker.readyPromise };
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop(): Promise<void> {
    if (this.stopping || this.stopped) return;
    this.stopping = true;
    this.child.stdin.end();
    await Promise.race([
      new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.child.kill();
          resolve();
        }, 2_000);
        timeout.unref?.();
      }),
    ]);
    this.stopped = true;
  }

  private receive(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk)) {
        if (!this.ready) {
          const ready = parseBrokerReady(frame);
          this.ready = true;
          this.decoder.setAuthenticated();
          this.resolveReady(ready);
        } else {
          void this.routeRequest(parseBrokerRequest(frame));
        }
      }
    } catch (error) {
      const failure = asError(error);
      this.rejectReady(failure);
      (this.options.reportError ?? console.error)(failure);
      void this.stop();
    }
  }

  private async routeRequest(frame: BrokerRequestV1): Promise<void> {
    try {
      const response = await this.options.handleRequest(frame.peer, frame.request);
      await this.write(
        {
          v: HOST_IPC_PROTOCOL_VERSION,
          type: "broker.response",
          connectionId: frame.connectionId,
          response,
        },
        true,
      );
      await this.options.afterResponse?.(frame.request, response);
    } catch (error) {
      (this.options.reportError ?? console.error)(error);
      void this.stop();
    }
  }

  private write(value: unknown, authenticated: boolean): Promise<void> {
    const frame = encodeHostIpcFrame(value, authenticated);
    return new Promise((resolve, reject) => {
      this.child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }

  private handleExit(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectReady(error);
    if (!this.stopping) this.options.onUnexpectedExit?.(error);
  }
}

function defaultSpawnBroker(executablePath: string): ChildProcessWithoutNullStreams {
  return spawn(executablePath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function parseBrokerReady(value: unknown): HostIpcBrokerReadyV1 {
  const frame = exactRecord(value, ["v", "type", "instanceId", "pipePath", "pid", "capabilities"]);
  if (frame.v !== 1 || frame.type !== "broker.ready") {
    throw new HostIpcProtocolError("Unsupported Host IPC broker readiness frame");
  }
  if (typeof frame.instanceId !== "string" || !/^[a-f0-9]{32}$/.test(frame.instanceId)) {
    throw new HostIpcProtocolError("Host IPC broker instanceId is invalid");
  }
  if (frame.pipePath !== `\\\\.\\pipe\\codex-collab-host-${frame.instanceId}`) {
    throw new HostIpcProtocolError("Host IPC broker pipe path is invalid");
  }
  if (!Number.isSafeInteger(frame.pid) || (frame.pid as number) <= 0) {
    throw new HostIpcProtocolError("Host IPC broker pid is invalid");
  }
  if (!Array.isArray(frame.capabilities) || frame.capabilities.length !== 2) {
    throw new HostIpcProtocolError("Host IPC broker capabilities are invalid");
  }
  const capabilities = frame.capabilities.map(parseReadyCapability);
  if (new Set(capabilities.map((candidate) => candidate.clientKind)).size !== 2) {
    throw new HostIpcProtocolError("Host IPC broker capabilities must be distinct");
  }
  return {
    instanceId: frame.instanceId,
    pipePath: frame.pipePath,
    brokerPid: frame.pid as number,
    capabilities,
  };
}

function parseBrokerRequest(value: unknown): BrokerRequestV1 {
  const frame = exactRecord(value, ["v", "type", "connectionId", "peer", "request"]);
  if (frame.v !== 1 || frame.type !== "broker.request") {
    throw new HostIpcProtocolError("Unsupported Host IPC broker request frame");
  }
  if (!Number.isSafeInteger(frame.connectionId) || (frame.connectionId as number) <= 0) {
    throw new HostIpcProtocolError("Host IPC broker connectionId is invalid");
  }
  const peer = parsePeer(frame.peer);
  return {
    connectionId: frame.connectionId as number,
    peer,
    request: parseHostIpcRequest(frame.request),
  };
}

function parsePeer(value: unknown): AuthenticatedHostIpcPeer {
  const peer = exactRecord(value, ["clientKind", "keyId", "sessionId", "authenticatedAt"]);
  if (peer.clientKind !== "mcp" && peer.clientKind !== "desktop") {
    throw new HostIpcProtocolError("Host IPC broker peer kind is invalid");
  }
  for (const [label, candidate] of [["keyId", peer.keyId], ["sessionId", peer.sessionId]] as const) {
    if (typeof candidate !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(candidate)) {
      throw new HostIpcProtocolError(`Host IPC broker peer ${label} is invalid`);
    }
  }
  if (!Number.isSafeInteger(peer.authenticatedAt) || (peer.authenticatedAt as number) < 0) {
    throw new HostIpcProtocolError("Host IPC broker peer timestamp is invalid");
  }
  return {
    clientKind: peer.clientKind,
    keyId: peer.keyId as string,
    sessionId: peer.sessionId as string,
    authenticatedAt: peer.authenticatedAt as number,
  };
}

function parseReadyCapability(value: unknown): HostIpcCapability {
  const capability = exactRecord(value, ["clientKind", "keyId", "secret"]);
  if (capability.clientKind !== "mcp" && capability.clientKind !== "desktop") {
    throw new HostIpcProtocolError("Host IPC broker capability kind is invalid");
  }
  if (typeof capability.keyId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(capability.keyId)) {
    throw new HostIpcProtocolError("Host IPC broker capability keyId is invalid");
  }
  if (typeof capability.secret !== "string") {
    throw new HostIpcProtocolError("Host IPC broker capability secret is invalid");
  }
  const secret = Buffer.from(capability.secret, "base64url");
  if (secret.byteLength !== 32) {
    throw new HostIpcProtocolError("Host IPC broker capability secret is invalid");
  }
  return { clientKind: capability.clientKind, keyId: capability.keyId, secret };
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostIpcProtocolError("Host IPC broker frame must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw new HostIpcProtocolError("Host IPC broker frame contains unsupported fields");
  }
  return record;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
