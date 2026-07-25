import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_IPC_FRAME_BYTES = 256 * 1024 * 1024;
const INITIALIZING_CLIENT_ID = "initializing-client";

const IPC_METHOD_VERSIONS: Readonly<Record<string, number>> = {
  "thread-follower-start-turn": 1,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 3,
};

interface DesktopIpcResponse {
  type: "response";
  requestId: string;
  resultType: "success" | "error";
  method?: string;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export type DesktopIpcSocketFactory = () => Socket;

export interface CodexDesktopIpcClientOptions {
  requestTimeoutMs?: number;
  socketFactory?: DesktopIpcSocketFactory;
}

export interface DesktopIpcInterruptResult {
  ok: true;
  interruptedTurnId: string | null;
}

export function codexDesktopIpcEndpoint(): string {
  if (process.platform !== "win32") {
    throw new Error("Codex Desktop IPC is currently supported on Windows only");
  }
  return "\\\\.\\pipe\\codex-ipc";
}

export function encodeDesktopIpcFrame(message: unknown): Buffer {
  const json = JSON.stringify(message);
  const length = Buffer.byteLength(json, "utf8");
  if (length === 0 || length > MAX_IPC_FRAME_BYTES) {
    throw new Error(`Invalid Codex Desktop IPC frame length: ${length}`);
  }
  const frame = Buffer.allocUnsafe(4 + length);
  frame.writeUInt32LE(length, 0);
  frame.write(json, 4, "utf8");
  return frame;
}

export class DesktopIpcFrameDecoder {
  private buffered = Buffer.alloc(0);

  reset(): void {
    this.buffered = Buffer.alloc(0);
  }

  push(chunk: Buffer): unknown[] {
    if (chunk.byteLength === 0) return [];
    this.buffered =
      this.buffered.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffered, chunk]);

    const messages: unknown[] = [];
    while (this.buffered.byteLength >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (length === 0 || length > MAX_IPC_FRAME_BYTES) {
        this.buffered = Buffer.alloc(0);
        throw new Error(`Invalid Codex Desktop IPC frame length: ${length}`);
      }
      if (this.buffered.byteLength < length + 4) break;
      const json = this.buffered.subarray(4, length + 4).toString("utf8");
      this.buffered = this.buffered.subarray(length + 4);
      messages.push(JSON.parse(json) as unknown);
    }
    return messages;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(response: DesktopIpcResponse): Error {
  const reason = response.error || "unknown-error";
  if (reason === "no-client-found") {
    return new Error(
      "Codex Desktop is not currently owning the selected conversation",
    );
  }
  return new Error(`Codex Desktop IPC request failed: ${reason}`);
}

export class CodexDesktopIpcClient {
  private readonly requestTimeoutMs: number;
  private readonly socketFactory: DesktopIpcSocketFactory;
  private readonly decoder = new DesktopIpcFrameDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private socket: Socket | null = null;
  private clientId = INITIALIZING_CLIENT_ID;
  private connecting: Promise<void> | null = null;
  private closed = false;

  constructor(options: CodexDesktopIpcClientOptions = {}) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.socketFactory =
      options.socketFactory ??
      (() => createConnection(codexDesktopIpcEndpoint()));
  }

  async startTurn(input: {
    conversationId: string;
    turnStartParams: Record<string, unknown>;
  }): Promise<unknown> {
    return this.request("thread-follower-start-turn", input);
  }

  async steerTurn(input: {
    conversationId: string;
    input: unknown[];
    restoreMessage: unknown;
    serviceTier: unknown;
    attachments: unknown[];
    clientUserMessageId: string;
    additionalContext: unknown;
  }): Promise<unknown> {
    return this.request("thread-follower-steer-turn", input);
  }

  async interruptTurn(input: {
    conversationId: string;
    mode?: string;
  }): Promise<DesktopIpcInterruptResult> {
    const result = await this.request("thread-follower-interrupt-turn", input);
    if (
      !isRecord(result) ||
      result.ok !== true ||
      !(
        result.interruptedTurnId === null ||
        typeof result.interruptedTurnId === "string"
      )
    ) {
      throw new Error(
        "Codex Desktop IPC returned an invalid interrupt result",
      );
    }
    return {
      ok: true,
      interruptedTurnId: result.interruptedTurnId,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connecting = null;
    this.rejectPending(new Error("Codex Desktop IPC client closed"));
    this.socket?.destroy();
    this.socket = null;
    this.clientId = INITIALIZING_CLIENT_ID;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    await this.connect();
    return this.sendRequest(
      method,
      params,
      IPC_METHOD_VERSIONS[method] ?? 0,
      this.clientId,
    );
  }

  private connect(): Promise<void> {
    if (
      this.socket?.writable &&
      this.clientId !== INITIALIZING_CLIENT_ID
    ) {
      return Promise.resolve();
    }
    if (this.connecting) return this.connecting;
    this.closed = false;
    this.connecting = new Promise<void>((resolve, reject) => {
      this.decoder.reset();
      const socket = this.socketFactory();
      this.socket = socket;
      let connected = false;

      const failConnect = (error: Error) => {
        if (connected) return;
        connected = true;
        this.connecting = null;
        this.socket = null;
        socket.destroy();
        reject(
          new Error(
            `Unable to connect to Codex Desktop IPC: ${error.message}`,
          ),
        );
      };

      socket.on("data", (chunk: Buffer) => {
        try {
          for (const message of this.decoder.push(chunk)) {
            this.handleMessage(message);
          }
        } catch (error) {
          socket.destroy(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
      socket.once("error", failConnect);
      socket.once("connect", () => {
        void this.sendRequest(
          "initialize",
          { clientType: "CODEX_COLLAB_HOST" },
          0,
          INITIALIZING_CLIENT_ID,
        )
          .then((result) => {
            if (
              !isRecord(result) ||
              typeof result.clientId !== "string" ||
              result.clientId.length === 0
            ) {
              throw new Error("Codex Desktop IPC returned no client id");
            }
            this.clientId = result.clientId;
            connected = true;
            socket.off("error", failConnect);
            socket.on("error", (error) => this.handleDisconnect(error));
            this.connecting = null;
            resolve();
          })
          .catch(failConnect);
      });
      socket.once("close", () => {
        if (!connected) {
          failConnect(new Error("connection closed during initialization"));
          return;
        }
        this.handleDisconnect(new Error("Codex Desktop IPC connection closed"));
      });
    });
    return this.connecting;
  }

  private sendRequest(
    method: string,
    params: unknown,
    version: number,
    sourceClientId: string,
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket?.writable) {
      return Promise.reject(new Error("Codex Desktop IPC is not connected"));
    }
    const requestId = randomUUID();
    const message = {
      type: "request",
      requestId,
      sourceClientId,
      version,
      method,
      params,
      timeoutMs: this.requestTimeoutMs,
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex Desktop IPC request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timeout.unref();
      this.pending.set(requestId, { method, resolve, reject, timeout });
      socket.write(encodeDesktopIpcFrame(message));
    });
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message) || typeof message.type !== "string") return;
    if (
      message.type === "client-discovery-request" &&
      typeof message.requestId === "string"
    ) {
      this.socket?.write(
        encodeDesktopIpcFrame({
          type: "client-discovery-response",
          requestId: message.requestId,
          response: { canHandle: false },
        }),
      );
      return;
    }
    if (message.type !== "response" || typeof message.requestId !== "string") {
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    const response = message as unknown as DesktopIpcResponse;
    if (response.resultType === "error") {
      pending.reject(responseError(response));
      return;
    }
    if (response.method && response.method !== pending.method) {
      pending.reject(
        new Error(
          `Codex Desktop IPC response method mismatch: ${response.method}`,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private handleDisconnect(error: Error): void {
    if (this.closed) return;
    this.socket = null;
    this.clientId = INITIALIZING_CLIENT_ID;
    this.connecting = null;
    this.decoder.reset();
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}
