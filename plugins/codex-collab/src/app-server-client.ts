import { EventEmitter } from "node:events";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import type { CodexRecordEntry } from "@codex-collab/protocol";

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface CodexThreadSummary {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string | null;
  status?: unknown;
  updatedAt?: number;
}

interface CodexThreadItem {
  type: string;
  id?: string;
  text?: string;
  content?: Array<{ type: string; text?: string }>;
}

interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  startedAt?: number | null;
}

export function extractCodexRecordEntries(turns: CodexTurn[]): CodexRecordEntry[] {
  const entries: CodexRecordEntry[] = [];
  for (const turn of turns) {
    const createdAt =
      typeof turn.startedAt === "number"
        ? new Date(turn.startedAt * 1_000).toISOString()
        : null;
    for (const item of turn.items) {
      let role: CodexRecordEntry["role"] | null = null;
      let value = "";
      if (item.type === "userMessage") {
        role = "user";
        value = (item.content ?? [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n");
      } else if (item.type === "agentMessage" && typeof item.text === "string") {
        role = "assistant";
        value = item.text;
      }
      const normalized = value.trim();
      if (!role || !normalized) continue;
      entries.push({
        id: item.id ?? `${turn.id}-${entries.length}`,
        role,
        text: normalized.slice(0, 20_000),
        createdAt,
      });
    }
  }

  const selected: CodexRecordEntry[] = [];
  let totalLength = 0;
  for (const entry of entries.slice(-200).reverse()) {
    if (totalLength + entry.text.length > 500_000) break;
    selected.push(entry);
    totalLength += entry.text.length;
  }
  return selected.reverse();
}

function resolveCodexExecutable(): string {
  if (process.env.CODEX_BIN) {
    return process.env.CODEX_BIN;
  }
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const output = execFileSync(locator, ["codex"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const executable = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!executable) {
    throw new Error("Codex CLI executable was not found on PATH");
  }
  return executable;
}

export class CodexAppServerClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  async start(): Promise<void> {
    if (this.process) return;
    this.process = spawn(resolveCodexExecutable(), ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.process.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.emit("diagnostic", text);
    });
    this.process.once("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.process = null;
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex-collab",
        title: "Codex Collab host bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.notify("initialized");
  }

  async listThreads(cwd?: string): Promise<CodexThreadSummary[]> {
    await this.start();
    const response = (await this.request("thread/list", {
      limit: 50,
      archived: false,
      sortKey: "updated_at",
      sortDirection: "desc",
      ...(cwd ? { cwd } : {}),
    })) as { data?: CodexThreadSummary[] };
    return response.data ?? [];
  }

  async readThreadHistory(threadId: string): Promise<CodexRecordEntry[]> {
    await this.start();
    const response = (await this.request("thread/read", {
      threadId,
      includeTurns: true,
    })) as { thread?: { turns?: CodexTurn[] } };
    return extractCodexRecordEntries(response.thread?.turns ?? []);
  }

  async submitPeerPrompt(input: {
    threadId: string;
    peerDisplayName: string;
    body: string;
  }): Promise<unknown> {
    await this.start();
    await this.request("thread/resume", {
      threadId: input.threadId,
      excludeTurns: true,
    });
    const prompt = `[Codex Collab member: ${input.peerDisplayName}]\n\n${input.body}`;
    return this.request("turn/start", {
      threadId: input.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      responsesapiClientMetadata: {
        source: "codex-collab",
        collab_member: input.peerDisplayName,
      },
    });
  }

  async close(): Promise<void> {
    if (!this.process) return;
    this.process.kill();
    this.process = null;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.process) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }
    const id = this.nextId++;
    const payload = `${JSON.stringify({ method, id, params })}\n`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process?.stdin.write(payload, "utf8");
    });
  }

  private notify(method: string, params?: unknown): void {
    this.process?.stdin.write(
      `${JSON.stringify(params === undefined ? { method } : { method, params })}\n`,
      "utf8",
    );
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
    if (message.method) {
      this.emit("notification", message);
    }
  }
}
