import { EventEmitter } from "node:events";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
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
  path?: string | null;
}

interface CodexThreadItem {
  type: string;
  id?: string;
  text?: string;
  content?: Array<{ type: string; text?: string } | string>;
  summary?: string[];
  command?: string;
  cwd?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
}

interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  startedAt?: number | null;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED TOKEN]",
    )
    .replace(
      /((?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET_KEY)\s*[=:]\s*)[^\s,;"']{8,}/gi,
      "$1[REDACTED]",
    );
}

function limitRecordEntries(entries: CodexRecordEntry[]): CodexRecordEntry[] {
  const selected: CodexRecordEntry[] = [];
  let totalLength = 0;
  for (const entry of entries.slice(-500).reverse()) {
    if (totalLength + entry.text.length > 2_000_000) break;
    selected.push(entry);
    totalLength += entry.text.length;
  }
  return selected.reverse();
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
          .filter(
            (part): part is { type: string; text: string } =>
              typeof part === "object" &&
              part.type === "text" &&
              typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("\n");
      } else if (item.type === "agentMessage" && typeof item.text === "string") {
        role = "assistant";
        value = item.text;
      } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
        role = "reasoning";
        value = item.summary.join("\n");
      } else if (item.type === "commandExecution" && typeof item.command === "string") {
        role = "command";
        value = [
          `$ ${item.command}`,
          item.cwd ? `cwd: ${item.cwd}` : "",
          item.aggregatedOutput ?? "",
          item.exitCode === null || item.exitCode === undefined
            ? ""
            : `exit code: ${item.exitCode}`,
          typeof item.durationMs === "number" ? `duration: ${item.durationMs} ms` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      const normalized = redactSensitiveText(value.trim());
      if (!role || !normalized) continue;
      entries.push({
        id: item.id ?? `${turn.id}-${entries.length}`,
        role,
        text: normalized.slice(0, 50_000),
        createdAt,
      });
    }
  }

  return limitRecordEntries(entries);
}

interface RolloutItem {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

function rolloutText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          return typeof item.text === "string" ? item.text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }
  return "";
}

export function extractCodexRolloutEntries(
  lines: string[],
  threadId: string,
): CodexRecordEntry[] {
  const entries: CodexRecordEntry[] = [];
  const commandCalls = new Map<
    string,
    { id: string; name: string; input: string; createdAt: string | null }
  >();
  const commandToolNames = new Set(["apply_patch", "exec", "exec_command", "write_stdin"]);

  for (const line of lines) {
    let item: RolloutItem;
    try {
      item = JSON.parse(line) as RolloutItem;
    } catch {
      continue;
    }
    if (item.type !== "response_item" || !item.payload) continue;
    const payload = item.payload;
    const payloadType = payload.type;
    const createdAt =
      typeof item.timestamp === "string" && !Number.isNaN(Date.parse(item.timestamp))
        ? new Date(item.timestamp).toISOString()
        : null;

    if (payloadType === "message" && (payload.role === "user" || payload.role === "assistant")) {
      const text = redactSensitiveText(rolloutText(payload.content).trim());
      if (!text) continue;
      entries.push({
        id:
          typeof payload.id === "string"
            ? payload.id
            : `${threadId}-message-${entries.length}`,
        role: payload.role,
        text: text.slice(0, 50_000),
        createdAt,
      });
      continue;
    }

    if (payloadType === "reasoning") {
      const text = redactSensitiveText(rolloutText(payload.summary).trim());
      if (!text) continue;
      entries.push({
        id:
          typeof payload.id === "string"
            ? payload.id
            : `${threadId}-reasoning-${entries.length}`,
        role: "reasoning",
        text: text.slice(0, 50_000),
        createdAt,
      });
      continue;
    }

    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const name = typeof payload.name === "string" ? payload.name : "";
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      if (!callId || !commandToolNames.has(name)) continue;
      commandCalls.set(callId, {
        id: typeof payload.id === "string" ? payload.id : callId,
        name,
        input: rolloutText(payload.arguments ?? payload.input),
        createdAt,
      });
      continue;
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      const call = commandCalls.get(callId);
      if (!call) continue;
      const output = rolloutText(payload.output);
      const text = redactSensitiveText(
        [`tool: ${call.name}`, call.input, output].filter(Boolean).join("\n").trim(),
      );
      if (text) {
        entries.push({
          id: call.id,
          role: "command",
          text: text.slice(0, 50_000),
          createdAt: call.createdAt ?? createdAt,
        });
      }
      commandCalls.delete(callId);
    }
  }
  return limitRecordEntries(entries);
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

  async readThreadHistory(
    threadId: string,
    rolloutPath?: string | null,
  ): Promise<CodexRecordEntry[]> {
    await this.start();
    if (
      rolloutPath &&
      isAbsolute(rolloutPath) &&
      extname(rolloutPath).toLowerCase() === ".jsonl" &&
      basename(rolloutPath).includes(threadId)
    ) {
      const resolved = await realpath(rolloutPath);
      const metadata = await stat(resolved);
      if (!metadata.isFile() || metadata.size > 20_000_000) {
        throw new Error("Selected Codex task history exceeds the 20 MB import limit");
      }
      const content = await readFile(resolved, "utf8");
      return extractCodexRolloutEntries(content.split(/\r?\n/), threadId);
    }
    const turns: CodexTurn[] = [];
    let cursor: string | null = null;
    do {
      const response = (await this.request("thread/turns/list", {
        threadId,
        cursor,
        limit: 100,
        sortDirection: "asc",
        itemsView: "full",
      })) as { data?: CodexTurn[]; nextCursor?: string | null };
      turns.push(...(response.data ?? []));
      cursor = response.nextCursor ?? null;
    } while (cursor && turns.length < 1_000);
    return extractCodexRecordEntries(turns);
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
