import { type Duplex } from "node:stream";
import { connect as connectNet } from "node:net";
import { type HostIpcCapability } from "./authentication.js";
import { HostIpcClientProtocol } from "./client.js";
import { type HostIpcClientEndpointV1 } from "./endpoint.js";
import { encodeHostIpcFrame, HostIpcFrameDecoder } from "./framing.js";
import {
  HOST_IPC_AUTH_TIMEOUT_MS,
  type HostIpcArguments,
  type HostIpcErrorV1,
  type HostIpcStatusV1,
  type HostToolMethod,
  HostIpcProtocolError,
  isHostToolMethod,
} from "./protocol.js";

const pipePathPattern = /^\\\\\.\\pipe\\codex-collab-host-[0-9a-f]{32}$/;

export type HostIpcStreamConnector = (pipePath: string) => Promise<Duplex>;

export interface HostIpcConnectOptions
  extends Pick<HostIpcClientEndpointV1, "pipePath" | "capability"> {
  connectStream?: HostIpcStreamConnector;
}

export interface McpHostIpcClient {
  callTool(
    method: HostToolMethod,
    params: HostIpcArguments,
    timeoutMs?: number,
  ): Promise<unknown>;
  status(timeoutMs?: number): Promise<HostIpcStatusV1>;
  close(): void;
}

export interface DesktopHostIpcClient {
  status(timeoutMs?: number): Promise<HostIpcStatusV1>;
  gracefulStop(timeoutMs?: number): Promise<void>;
  close(): void;
}

export class HostIpcRemoteError extends HostIpcProtocolError {
  constructor(error: HostIpcErrorV1) {
    super(error.message, error.code);
    this.name = "HostIpcRemoteError";
  }
}

export function connectHostIpcClient(
  options: HostIpcConnectOptions & {
    capability: HostIpcCapability & { clientKind: "mcp" };
  },
): Promise<McpHostIpcClient>;
export function connectHostIpcClient(
  options: HostIpcConnectOptions & {
    capability: HostIpcCapability & { clientKind: "desktop" };
  },
): Promise<DesktopHostIpcClient>;
export function connectHostIpcClient(
  options: HostIpcConnectOptions,
): Promise<McpHostIpcClient | DesktopHostIpcClient>;
export async function connectHostIpcClient(
  options: HostIpcConnectOptions,
): Promise<McpHostIpcClient | DesktopHostIpcClient> {
  assertPipePath(options.pipePath);
  const stream = await (options.connectStream ?? connectNamedPipe)(options.pipePath);
  const connection = new AuthenticatedHostIpcConnection(stream, options.capability);
  await connection.authenticate();
  return options.capability.clientKind === "mcp"
    ? new McpHostIpcClientImpl(connection)
    : new DesktopHostIpcClientImpl(connection);
}

class McpHostIpcClientImpl implements McpHostIpcClient {
  constructor(private readonly connection: AuthenticatedHostIpcConnection) {}

  callTool(
    method: HostToolMethod,
    params: HostIpcArguments,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (!isHostToolMethod(method)) {
      return Promise.reject(
        new HostIpcProtocolError("IPC method is not an MCP tool", "method_not_allowed"),
      );
    }
    return this.connection.call(method, params, timeoutMs);
  }

  async status(timeoutMs?: number): Promise<HostIpcStatusV1> {
    return parseStatus(await this.connection.call("host.status", {}, timeoutMs));
  }

  close(): void {
    this.connection.close();
  }
}

class DesktopHostIpcClientImpl implements DesktopHostIpcClient {
  constructor(private readonly connection: AuthenticatedHostIpcConnection) {}

  async status(timeoutMs?: number): Promise<HostIpcStatusV1> {
    return parseStatus(await this.connection.call("host.status", {}, timeoutMs));
  }

  async gracefulStop(timeoutMs?: number): Promise<void> {
    const result = await this.connection.call("host.gracefulStop", {}, timeoutMs);
    if (!isRecord(result) || result.stopping !== true || Object.keys(result).length !== 1) {
      throw new HostIpcProtocolError("Host graceful-stop response is invalid", "host_error");
    }
  }

  close(): void {
    this.connection.close();
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type ConnectionState = "challenge" | "ready" | "authenticated" | "closed";

class AuthenticatedHostIpcConnection {
  private readonly protocol: HostIpcClientProtocol;
  private readonly decoder = new HostIpcFrameDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private state: ConnectionState = "challenge";
  private authTimer: ReturnType<typeof setTimeout> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly authenticated: Promise<void>;
  private resolveAuthenticated!: () => void;
  private rejectAuthenticated!: (error: Error) => void;

  constructor(
    private readonly stream: Duplex,
    capability: HostIpcCapability,
  ) {
    this.protocol = new HostIpcClientProtocol(capability);
    this.authenticated = new Promise<void>((resolve, reject) => {
      this.resolveAuthenticated = resolve;
      this.rejectAuthenticated = reject;
    });
    stream.on("data", this.onData);
    stream.once("error", this.onError);
    stream.once("end", this.onEnd);
    stream.once("close", this.onClose);
  }

  async authenticate(): Promise<void> {
    this.authTimer = setTimeout(() => {
      this.fail(
        new HostIpcProtocolError("Host IPC authentication timed out", "request_timeout"),
      );
    }, HOST_IPC_AUTH_TIMEOUT_MS);
    this.authTimer.unref?.();
    void this.sendFrame(this.protocol.hello(), false).catch((error: unknown) => {
      this.fail(asError(error, "Host IPC authentication write failed"));
    });
    await this.authenticated;
  }

  call(
    method: HostToolMethod | "host.status" | "host.gracefulStop",
    params: HostIpcArguments,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (this.state !== "authenticated") {
      return Promise.reject(new HostIpcProtocolError("Host IPC connection is closed", "host_error"));
    }

    let request;
    let frame: Buffer;
    try {
      request = this.protocol.request(method, params, timeoutMs);
      frame = encodeHostIpcFrame(request, true);
    } catch (error) {
      return Promise.reject(asError(error, "Host IPC request is invalid"));
    }

    const response = new Promise<unknown>((resolve, reject) => {
      // timeoutMs is the server admission deadline. Once accepted, HostApplication work is
      // not cancellable; waiting for its real result prevents a retry from duplicating effects.
      this.pending.set(request.id, { resolve, reject });
    });
    void this.sendEncodedFrame(frame).catch((error: unknown) => {
      this.fail(asError(error, "Host IPC request write failed"));
    });
    return response;
  }

  close(): void {
    this.finish(new HostIpcProtocolError("Host IPC connection was closed", "host_error"), true);
  }

  private readonly onData = (chunk: Buffer): void => {
    try {
      for (const frame of this.decoder.push(chunk)) this.acceptFrame(frame);
    } catch (error) {
      this.fail(asError(error, "Host IPC frame was rejected"));
    }
  };

  private readonly onError = (error: Error): void => {
    this.finish(error, true);
  };

  private readonly onEnd = (): void => {
    this.finish(new HostIpcProtocolError("Host IPC connection ended", "host_error"), true);
  };

  private readonly onClose = (): void => {
    this.finish(new HostIpcProtocolError("Host IPC connection closed", "host_error"), false);
  };

  private acceptFrame(frame: unknown): void {
    if (this.state === "challenge") {
      const proof = this.protocol.answerChallenge(frame);
      this.state = "ready";
      void this.sendFrame(proof, false).catch((error: unknown) => {
        this.fail(asError(error, "Host IPC authentication write failed"));
      });
      return;
    }
    if (this.state === "ready") {
      this.protocol.acceptReady(frame);
      this.state = "authenticated";
      this.decoder.setAuthenticated();
      if (this.authTimer) clearTimeout(this.authTimer);
      this.authTimer = undefined;
      this.resolveAuthenticated();
      return;
    }
    if (this.state !== "authenticated") {
      throw new HostIpcProtocolError("Host IPC received a frame after close", "host_error");
    }

    const response = this.protocol.acceptResponse(frame);
    const pending = this.pending.get(response.id);
    if (!pending) {
      throw new HostIpcProtocolError("IPC response id has no pending caller", "request_replayed");
    }
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new HostIpcRemoteError(response.error));
  }

  private sendFrame(value: unknown, authenticated: boolean): Promise<void> {
    return this.sendEncodedFrame(encodeHostIpcFrame(value, authenticated));
  }

  private sendEncodedFrame(frame: Buffer): Promise<void> {
    const write = this.writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.state === "closed" || this.stream.destroyed) {
            reject(new HostIpcProtocolError("Host IPC connection is closed", "host_error"));
            return;
          }
          this.stream.write(frame, (error?: Error | null) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private fail(error: Error): void {
    this.finish(error, true);
  }

  private finish(error: Error, destroy: boolean): void {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = undefined;
    this.protocol.disconnect();
    this.rejectAuthenticated(error);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    if (destroy && !this.stream.destroyed) this.stream.destroy();
  }
}

function connectNamedPipe(pipePath: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const stream = connectNet(pipePath);
    const onError = (error: Error) => {
      stream.off("connect", onConnect);
      reject(error);
    };
    const onConnect = () => {
      stream.off("error", onError);
      resolve(stream);
    };
    stream.once("error", onError);
    stream.once("connect", onConnect);
  });
}

function assertPipePath(pipePath: string): void {
  if (!pipePathPattern.test(pipePath)) {
    throw new HostIpcProtocolError("Host IPC pipe path is invalid", "forbidden");
  }
}

function parseStatus(value: unknown): HostIpcStatusV1 {
  if (!isRecord(value)) throw invalidStatus();
  const keys = Object.keys(value);
  if (keys.some((key) => !["phase", "paired", "acceptingWork", "since", "detail"].includes(key))) {
    throw invalidStatus();
  }
  if (
    !["unpaired", "active", "draining", "suspended", "catching-up", "failed"].includes(
      String(value.phase),
    ) ||
    typeof value.paired !== "boolean" ||
    typeof value.acceptingWork !== "boolean" ||
    typeof value.since !== "string" ||
    value.since.length === 0 ||
    (value.detail !== undefined && typeof value.detail !== "string")
  ) {
    throw invalidStatus();
  }
  return value as unknown as HostIpcStatusV1;
}

function invalidStatus(): HostIpcProtocolError {
  return new HostIpcProtocolError("Host status response is invalid", "host_error");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
