import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexAppServerProcess } from "./process-lifecycle.js";

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class JsonRpcTransport extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly lifecycle = new CodexAppServerProcess()) {
    super();
    lifecycle.on("diagnostic", (text) => this.emit("diagnostic", text));
    lifecycle.on("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.child = null;
      this.emit("exit", code, signal);
    });
  }

  start(): void {
    if (this.child) return;
    const child = this.lifecycle.start();
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }
    const id = this.nextId++;
    const payload = `${JSON.stringify({ method, id, params })}\n`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child?.stdin.write(payload, "utf8");
    });
  }

  notify(method: string, params?: unknown): void {
    this.child?.stdin.write(
      `${JSON.stringify(params === undefined ? { method } : { method, params })}\n`,
      "utf8",
    );
  }

  close(): void {
    this.lifecycle.stop();
    this.child = null;
  }

  private handleLine(line: string): void {
    let message: RpcResponse & { method?: string; params?: unknown };
    try {
      message = JSON.parse(line) as RpcResponse & { method?: string; params?: unknown };
    } catch {
      this.emit("diagnostic", line);
      return;
    }
    if (typeof message.id === "number") {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(message.error.message ?? "Codex app-server request failed"));
      } else {
        request.resolve(message.result);
      }
      return;
    }
    if (message.method) this.emit("notification", message);
  }
}
