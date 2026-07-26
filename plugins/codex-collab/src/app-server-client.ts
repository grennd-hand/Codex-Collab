import { EventEmitter } from "node:events";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  codexModelSupportsFast,
  codexModelSupportsImages,
  codexModelSupportsReasoningEffort,
  normalizeCodexModelId,
  sanitizeCodexAssistantMessageText,
  sanitizeCodexUserMessageText,
  type CodexPromptOptions,
  type CodexRecordEntry,
  type CodexReasoningEffort,
} from "@codex-collab/protocol";
import { CodexDesktopIpcClient } from "./codex-desktop-ipc-client.js";

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

export interface CodexPromptSubmission {
  status: "submitted" | "deferred";
  reason?: string | null;
  mode?: "started" | "steered" | "interrupted";
  turnId?: string | null;
}

type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string; detail: "auto" }
  | { type: "mention"; name: string; path: string };

interface ThreadResumeResponse {
  thread?: unknown;
  model?: string | null;
  reasoningEffort?: string | null;
}

interface TurnStartResponse {
  turn?: { id?: string };
}

type CodexDesktopBridge = Pick<
  CodexDesktopIpcClient,
  "startTurn" | "steerTurn" | "interruptTurn" | "close"
>;

export interface CodexAppServerClientOptions {
  desktopIpc?: CodexDesktopBridge;
  platform?: NodeJS.Platform;
}

const MODEL_IDS: Readonly<Record<string, string>> = {
  "5.6 Sol": "gpt-5.6-sol",
  "5.6 Terra": "gpt-5.6-terra",
  "5.6 Luna": "gpt-5.6-luna",
  "5.5": "gpt-5.5",
  "5.4": "gpt-5.4",
  "5.4 Mini": "gpt-5.4-mini",
  "5.3 Codex Spark": "gpt-5.3-codex-spark",
};

const INLINE_TEXT_EXTENSIONS = new Set([
  ".cfg",
  ".conf",
  ".css",
  ".csv",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".mts",
  ".ps1",
  ".py",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export function decodeInlineTextAttachment(input: {
  name: string;
  mediaType: string;
  content: Uint8Array;
}): string | null {
  if (input.content.byteLength > 1_000_000) return null;
  const mediaType = input.mediaType.toLowerCase();
  const isText =
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/javascript" ||
    mediaType === "application/xml" ||
    INLINE_TEXT_EXTENSIONS.has(extname(input.name).toLowerCase());
  if (!isText) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input.content);
  } catch {
    return null;
  }
}

function resolveModelId(model: string | null): string | null {
  if (!model) return null;
  return MODEL_IDS[model] ?? model;
}

function isUnmaterializedThreadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("is not materialized yet") ||
      error.message.includes("no rollout found for thread id"))
  );
}

function isEmptyRolloutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("rollout") &&
    error.message.includes("is empty");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nestedTurnId(value: unknown, depth = 0): string | null {
  if (
    depth > 6 ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.turnId === "string" && record.turnId.length > 0) {
    return record.turnId;
  }
  const turn = record.turn;
  if (
    typeof turn === "object" &&
    turn !== null &&
    !Array.isArray(turn) &&
    typeof (turn as Record<string, unknown>).id === "string"
  ) {
    return (turn as Record<string, unknown>).id as string;
  }
  for (const key of ["result", "response", "data"]) {
    const found = nestedTurnId(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function buildCodexTurnStartParams(input: {
  threadId: string;
  userInput: CodexUserInput[];
  attachmentMediaTypes?: readonly string[];
  options: CodexPromptOptions;
  currentModel?: string | null;
  currentReasoningEffort?: string | null;
  peerDisplayName: string;
  commandId?: string;
}): Record<string, unknown> {
  const requestedModel = resolveModelId(input.options.model);
  const effectiveModel = requestedModel ?? input.currentModel ?? null;
  const knownEffectiveModel = effectiveModel
    ? normalizeCodexModelId(effectiveModel)
    : null;
  const requestedEffort =
    input.options.reasoningEffort === "follow-desktop"
      ? null
      : input.options.reasoningEffort;
  if (
    knownEffectiveModel &&
    !codexModelSupportsReasoningEffort(
      knownEffectiveModel,
      input.options.reasoningEffort,
    )
  ) {
    throw new Error(
      `${input.options.reasoningEffort} reasoning is not supported by ${knownEffectiveModel}`,
    );
  }
  if (
    knownEffectiveModel &&
    input.options.speed === "fast" &&
    !codexModelSupportsFast(knownEffectiveModel)
  ) {
    throw new Error(`Fast speed is not supported by ${knownEffectiveModel}`);
  }
  if (
    knownEffectiveModel &&
    !codexModelSupportsImages(knownEffectiveModel) &&
    (input.userInput.some((item) => item.type === "localImage") ||
      input.attachmentMediaTypes?.some((mediaType) =>
        mediaType.startsWith("image/"),
      ))
  ) {
    throw new Error(`Image attachments are not supported by ${knownEffectiveModel}`);
  }
  const parameters: Record<string, unknown> = {
    threadId: input.threadId,
    input: input.userInput,
    responsesapiClientMetadata: {
      source: "codex-collab",
      collab_member: input.peerDisplayName,
      ...(input.commandId ? { collab_command_id: input.commandId } : {}),
    },
  };

  if (requestedModel) parameters.model = requestedModel;
  if (requestedEffort) parameters.effort = requestedEffort;
  if (input.options.speed === "fast") {
    parameters.serviceTier = "priority";
  } else if (input.options.speed === "standard") {
    parameters.serviceTier = null;
  }

  if (input.options.accessMode === "request-approval") {
    parameters.permissions = ":workspace";
    parameters.approvalPolicy = "on-request";
  } else if (input.options.accessMode === "auto") {
    parameters.permissions = ":workspace";
    parameters.approvalPolicy = "never";
  } else if (input.options.accessMode === "full-access") {
    parameters.permissions = ":danger-full-access";
    parameters.approvalPolicy = "never";
  } else if (input.options.accessMode === "custom") {
    const customPermissions = input.options.customPermissions;
    if (!customPermissions) {
      throw new Error("Custom Codex permissions are missing");
    }
    const permissionProfile = {
      "read-only": ":read-only",
      "workspace-write": ":workspace",
      "full-access": ":danger-full-access",
    }[customPermissions.fileAccess];
    if (!permissionProfile) {
      throw new Error("Custom Codex file access is invalid");
    }
    if (
      customPermissions.approvalPolicy !== "on-request" &&
      customPermissions.approvalPolicy !== "never"
    ) {
      throw new Error("Custom Codex approval policy is invalid");
    }
    parameters.permissions = permissionProfile;
    parameters.approvalPolicy = customPermissions.approvalPolicy;
  }

  if (input.options.planMode || requestedModel || requestedEffort) {
    if (!effectiveModel) {
      throw new Error(
        "Selected Codex options require the selected task's current model",
      );
    }
    parameters.collaborationMode = {
      mode: input.options.planMode ? "plan" : "default",
      settings: {
        model: effectiveModel,
        reasoning_effort:
          requestedEffort ??
          (knownEffectiveModel && input.currentReasoningEffort
            ? codexModelSupportsReasoningEffort(
                knownEffectiveModel,
                input.currentReasoningEffort as CodexReasoningEffort,
              )
              ? input.currentReasoningEffort
              : null
            : input.currentReasoningEffort ?? null),
        developer_instructions: null,
      },
    };
  }
  return parameters;
}

export async function readCodexThreadRevision(
  thread: CodexThreadSummary,
): Promise<string | null> {
  const updatedAt =
    typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt)
      ? `updated:${thread.updatedAt}`
      : null;
  if (
    !thread.path ||
    !isAbsolute(thread.path) ||
    extname(thread.path).toLowerCase() !== ".jsonl" ||
    !basename(thread.path).includes(thread.id)
  ) {
    return updatedAt;
  }
  try {
    const resolved = await realpath(thread.path);
    const metadata = await stat(resolved);
    if (!metadata.isFile()) {
      return updatedAt;
    }
    return [updatedAt, `rollout:${metadata.size}:${metadata.mtimeMs}`]
      .filter(Boolean)
      .join("|");
  } catch {
    return updatedAt;
  }
}

interface CodexThreadItem {
  type: string;
  id?: string;
  status?: string;
  phase?: string;
  text?: string;
  content?: Array<{ type: string; text?: string } | string>;
  summary?: string[];
  command?: string;
  cwd?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: Array<{
    path?: string;
    kind?: { type?: string; move_path?: string | null };
    diff?: string;
  }>;
}

interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  status?: CodexTurnStatus;
  startedAt?: number | null;
}

export type CodexTurnStatus =
  | "completed"
  | "interrupted"
  | "failed"
  | "inProgress";

export interface CodexRolloutActivity {
  openTurnIds: string[];
  latestObservedTurnId: string | null;
  latestObservedAtMs: number | null;
}

export function extractCodexRolloutActivity(
  lines: string[],
  initial: CodexRolloutActivity = {
    openTurnIds: [],
    latestObservedTurnId: null,
    latestObservedAtMs: null,
  },
): CodexRolloutActivity {
  const openTurnIds = new Set(initial.openTurnIds);
  let latestObservedTurnId = initial.latestObservedTurnId;
  let latestObservedAtMs = initial.latestObservedAtMs;

  for (const line of lines) {
    let item: RolloutItem;
    try {
      item = JSON.parse(line) as RolloutItem;
    } catch {
      continue;
    }
    if (!item.payload) continue;

    const directTurnId =
      typeof item.payload.turn_id === "string"
        ? item.payload.turn_id
        : null;
    const metadata = item.payload.internal_chat_message_metadata_passthrough;
    const metadataTurnId =
      metadata &&
      typeof metadata === "object" &&
      "turn_id" in metadata &&
      typeof metadata.turn_id === "string"
        ? metadata.turn_id
        : null;
    const observedTurnId = metadataTurnId ?? directTurnId;
    if (observedTurnId) {
      latestObservedTurnId = observedTurnId;
      if (
        typeof item.timestamp === "string" &&
        !Number.isNaN(Date.parse(item.timestamp))
      ) {
        latestObservedAtMs = Date.parse(item.timestamp);
      }
    }

    if (item.type !== "event_msg" || !directTurnId) continue;
    if (item.payload.type === "task_started") {
      openTurnIds.add(directTurnId);
    } else if (item.payload.type === "task_complete") {
      openTurnIds.delete(directTurnId);
    }
  }

  return {
    openTurnIds: [...openTurnIds],
    latestObservedTurnId,
    latestObservedAtMs,
  };
}

const TERMINAL_ROLLOUT_GRACE_MS = 120_000;

export function isCodexThreadBusy(
  activity: CodexRolloutActivity,
  turns: ReadonlyArray<{ id: string; status?: CodexTurnStatus }>,
  nowMs = Date.now(),
): boolean {
  if (turns.some((turn) => turn.status === "inProgress")) {
    return true;
  }
  if (activity.openTurnIds.length === 0) {
    return false;
  }
  if (
    !activity.latestObservedTurnId ||
    !activity.openTurnIds.includes(activity.latestObservedTurnId)
  ) {
    return false;
  }
  if (activity.latestObservedAtMs === null) {
    return true;
  }
  return nowMs - activity.latestObservedAtMs < TERMINAL_ROLLOUT_GRACE_MS;
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

function lineChangeCounts(diff: string): { additions: number; deletions: number } {
  const lines = diff.split(/\r?\n/);
  return {
    additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
  };
}

function safeFileChangeSummary(
  path: string,
  type: string,
  movePath: string | null,
  diff = "",
): string {
  const operation =
    type === "add" ? "新增" : type === "delete" ? "删除" : type === "move" ? "移动" : "修改";
  const destination = movePath ? ` → ${movePath}` : "";
  const { additions, deletions } = lineChangeCounts(diff);
  const counts = additions > 0 || deletions > 0 ? `（+${additions} -${deletions}）` : "";
  return `${operation} ${path}${destination}${counts}`;
}

function appServerFileChangeText(item: CodexThreadItem): string {
  const changes = (item.changes ?? [])
    .map((change) => {
      if (typeof change.path !== "string" || !change.path.trim()) return null;
      return safeFileChangeSummary(
        change.path,
        change.kind?.type ?? "update",
        change.kind?.move_path ?? null,
        change.diff ?? "",
      );
    })
    .filter((change): change is string => Boolean(change));
  if (changes.length === 0) return "";
  const status = item.status === "failed" ? "failed" : item.status === "inProgress" ? "running" : "completed";
  return rolloutCommandText("apply_patch", status, changes.join("\n"));
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
        const commandStatus =
          item.exitCode === null || item.exitCode === undefined
            ? turn.status === "inProgress"
              ? "running"
              : "completed"
            : item.exitCode === 0
              ? "completed"
              : "failed";
        value = [
          "tool: exec_command",
          `status: ${commandStatus}`,
          "input:",
          `$ ${item.command}`,
          item.cwd ? `目录：${item.cwd}` : "",
          item.aggregatedOutput ||
          (item.exitCode !== null && item.exitCode !== undefined)
            ? "output:"
            : "",
          item.aggregatedOutput ?? "",
          item.exitCode === null || item.exitCode === undefined
            ? ""
            : `exit code: ${item.exitCode}`,
          typeof item.durationMs === "number" ? `duration: ${item.durationMs} ms` : "",
        ]
          .filter(Boolean)
          .join("\n");
      } else if (item.type === "fileChange") {
        role = "command";
        value = appServerFileChangeText(item);
      }
      const normalized = redactSensitiveText(
        (role === "user"
          ? sanitizeCodexUserMessageText(value)
          : role === "assistant"
            ? sanitizeCodexAssistantMessageText(value)
            : value
        ).trim(),
      );
      if (!role || !normalized) continue;
      entries.push({
        id: item.id ?? `${turn.id}-${entries.length}`,
        role,
        ...(role === "assistant" &&
          (item.phase === "commentary" || item.phase === "final_answer")
          ? { phase: item.phase }
          : {}),
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

function rolloutCommandText(
  name: string,
  status: "running" | "completed" | "failed",
  input: string,
  output?: string,
): string {
  return [
    `tool: ${name}`,
    `status: ${status}`,
    input.trim() ? `input:\n${input.trim()}` : "",
    output?.trim() ? `output:\n${output.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function rolloutPatchInput(payload: Record<string, unknown>): string {
  if (!payload.changes || typeof payload.changes !== "object") return "";
  const changes = Object.entries(payload.changes as Record<string, unknown>)
    .map(([path, rawChange]) => {
      if (!rawChange || typeof rawChange !== "object") return null;
      const change = rawChange as Record<string, unknown>;
      const type = typeof change.type === "string" ? change.type : "update";
      const diff = typeof change.unified_diff === "string" ? change.unified_diff : "";
      const movePath = typeof change.move_path === "string" ? change.move_path : null;
      return safeFileChangeSummary(path, type, movePath, diff);
    })
    .filter((change): change is string => Boolean(change));
  return changes.join("\n");
}

function safeApplyPatchCallInput(input: string): string {
  const changes = input
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\*\*\*\s+(Add|Update|Delete|Move) File:\s+(.+)$/);
      if (!match?.[1] || !match[2]) return null;
      return safeFileChangeSummary(match[2].trim(), match[1].toLowerCase(), null);
    })
    .filter((change): change is string => Boolean(change));
  return changes.length > 0 ? changes.join("\n") : "修改文件（补丁正文已隐藏）";
}

export function extractCodexRolloutEntries(
  lines: string[],
  threadId: string,
): CodexRecordEntry[] {
  const entries: CodexRecordEntry[] = [];
  const commandCalls = new Map<
    string,
    {
      id: string;
      name: string;
      input: string;
      createdAt: string | null;
      status?: "completed" | "failed";
      output?: string;
    }
  >();
  const commandToolNames = new Set(["apply_patch", "exec", "exec_command", "write_stdin"]);

  for (const line of lines) {
    let item: RolloutItem;
    try {
      item = JSON.parse(line) as RolloutItem;
    } catch {
      continue;
    }
    if (!item.payload) continue;
    const payload = item.payload;
    const payloadType = payload.type;
    const createdAt =
      typeof item.timestamp === "string" && !Number.isNaN(Date.parse(item.timestamp))
        ? new Date(item.timestamp).toISOString()
        : null;

    if (item.type === "event_msg" && payloadType === "patch_apply_end") {
      const input = rolloutPatchInput(payload);
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      const success = payload.success !== false && payload.status !== "failed";
      const status = success ? "completed" : "failed";
      const output = [rolloutText(payload.stdout), rolloutText(payload.stderr)]
        .map((value) => value.trim())
        .filter(Boolean)
        .join("\n");
      const pendingCall = callId ? commandCalls.get(callId) : null;
      if (pendingCall && input) {
        pendingCall.input = input;
        pendingCall.status = status;
        pendingCall.output = output;
      } else if (input) {
        const text = redactSensitiveText(rolloutCommandText("apply_patch", status, input, output));
        entries.push({
          id: `${threadId}-patch-${callId || entries.length}`,
          role: "command",
          text: text.slice(0, 50_000),
          createdAt,
        });
      }
      continue;
    }

    if (item.type !== "response_item") continue;

    if (payloadType === "message" && (payload.role === "user" || payload.role === "assistant")) {
      const rawText = rolloutText(payload.content).trim();
      const text = redactSensitiveText(
        payload.role === "user"
          ? sanitizeCodexUserMessageText(rawText)
          : sanitizeCodexAssistantMessageText(rawText),
      );
      if (!text) continue;
      entries.push({
        id:
          typeof payload.id === "string"
            ? payload.id
            : `${threadId}-message-${entries.length}`,
        role: payload.role,
        ...(payload.role === "assistant" &&
          (payload.phase === "commentary" || payload.phase === "final_answer")
          ? { phase: payload.phase }
          : {}),
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
        input:
          name === "apply_patch"
            ? safeApplyPatchCallInput(rolloutText(payload.arguments ?? payload.input))
            : rolloutText(payload.arguments ?? payload.input),
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
        rolloutCommandText(
          call.name,
          call.status ?? "completed",
          call.input,
          output || call.output,
        ),
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

  for (const call of commandCalls.values()) {
    const text = redactSensitiveText(
      rolloutCommandText(call.name, call.status ?? "running", call.input, call.output),
    );
    if (!text) continue;
    entries.push({
      id: call.id,
      role: "command",
      text: text.slice(0, 50_000),
      createdAt: call.createdAt,
    });
  }
  return limitRecordEntries(entries);
}

const MAX_RECENT_ROLLOUT_BYTES = 20_000_000;

async function readRecentRolloutLines(
  path: string,
  size: number,
): Promise<string[]> {
  const start = Math.max(0, size - MAX_RECENT_ROLLOUT_BYTES);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const handle = await openFile(path, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(buffer, offset, length - offset, start + offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    let content = buffer.subarray(0, offset).toString("utf8");
    if (start > 0) {
      const firstLineEnd = content.indexOf("\n");
      content = firstLineEnd < 0 ? "" : content.slice(firstLineEnd + 1);
    }
    return content.split(/\r?\n/);
  } finally {
    await handle.close();
  }
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
  private readonly stagedAttachments = new Map<string, Set<string>>();
  private readonly rolloutActivityCache = new Map<
    string,
    {
      size: number;
      pendingLine: string;
      activity: CodexRolloutActivity;
    }
  >();
  private readonly desktopIpc: CodexDesktopBridge;
  private readonly platform: NodeJS.Platform;

  constructor(options: CodexAppServerClientOptions = {}) {
    super();
    this.desktopIpc = options.desktopIpc ?? new CodexDesktopIpcClient();
    this.platform = options.platform ?? process.platform;
  }

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
      void this.cleanupAllStagedAttachments();
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
      if (metadata.isFile()) {
        const lines =
          metadata.size <= MAX_RECENT_ROLLOUT_BYTES
            ? (await readFile(resolved, "utf8")).split(/\r?\n/)
            : await readRecentRolloutLines(resolved, metadata.size);
        const rolloutEntries = extractCodexRolloutEntries(lines, threadId);
        if (metadata.size <= MAX_RECENT_ROLLOUT_BYTES || rolloutEntries.length > 0) {
          return rolloutEntries;
        }
      }
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

  async isThreadBusyForPrompt(
    threadId: string,
    rolloutPath?: string | null,
  ): Promise<boolean> {
    await this.start();
    await this.request("thread/resume", {
      threadId,
      excludeTurns: true,
    });
    const response = (await this.request("thread/turns/list", {
      threadId,
      limit: 50,
      sortDirection: "desc",
      itemsView: "summary",
    })) as { data?: CodexTurn[] };

    let activity: CodexRolloutActivity = {
      openTurnIds: [],
      latestObservedTurnId: null,
      latestObservedAtMs: null,
    };
    if (
      rolloutPath &&
      isAbsolute(rolloutPath) &&
      extname(rolloutPath).toLowerCase() === ".jsonl" &&
      basename(rolloutPath).includes(threadId)
    ) {
      const resolved = await realpath(rolloutPath);
      const metadata = await stat(resolved);
      if (metadata.isFile()) {
        activity = await this.readRolloutActivity(resolved, metadata.size);
      }
    }

    return isCodexThreadBusy(activity, response.data ?? []);
  }

  async submitPeerPrompt(input: {
    threadId: string;
    projectRoot: string;
    commandId: string;
    peerDisplayName: string;
    body: string;
    attachments: Array<{
      name: string;
      mediaType: string;
      content: Uint8Array;
    }>;
    codexOptions: CodexPromptOptions;
  }): Promise<CodexPromptSubmission> {
    await this.start();
    const preparedAttachments = input.attachments.map((attachment) => ({
      attachment,
      inlineText: decodeInlineTextAttachment(attachment),
    }));
    let stagingDirectory: string | null = null;
    if (preparedAttachments.some((entry) => entry.inlineText === null)) {
      const approvedRoot = await realpath(input.projectRoot);
      const stagingRoot = join(approvedRoot, ".codex-collab");
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      stagingDirectory = await mkdtemp(join(stagingRoot, "attachments-"));
    }
    const userInput: CodexUserInput[] = [
      { type: "text", text: input.body, text_elements: [] },
    ];
    let stagingRegistered = false;
    try {
      for (const [index, prepared] of preparedAttachments.entries()) {
        const { attachment, inlineText } = prepared;
        if (inlineText !== null) {
          userInput.push({
            type: "text",
            text: `\n\nAttached file: ${attachment.name}\n${inlineText}`,
            text_elements: [],
          });
          continue;
        }
        if (stagingDirectory) {
          const path = join(
            stagingDirectory,
            `${String(index + 1).padStart(2, "0")}-${basename(attachment.name)}`,
          );
          await writeFile(path, attachment.content, { mode: 0o600 });
          userInput.push(
            attachment.mediaType.startsWith("image/")
              ? { type: "localImage", path, detail: "auto" }
              : { type: "mention", name: attachment.name, path },
          );
        }
      }

      const activeTurnId = await this.getActiveTurnId(input.threadId);
      if (activeTurnId) {
        return {
          status: "deferred",
          reason: "active-turn",
          turnId: activeTurnId,
        };
      }

      let resumed: ThreadResumeResponse = {};
      try {
        resumed = (await this.request("thread/resume", {
          threadId: input.threadId,
          excludeTurns: true,
        })) as ThreadResumeResponse;
      } catch (error) {
        if (!isUnmaterializedThreadError(error)) throw error;
      }
      const startParameters = buildCodexTurnStartParams({
        threadId: input.threadId,
        userInput,
        attachmentMediaTypes: input.attachments.map(
          (attachment) => attachment.mediaType,
        ),
        options: input.codexOptions,
        currentModel: resumed.model ?? null,
        currentReasoningEffort: resumed.reasoningEffort ?? null,
        peerDisplayName: input.peerDisplayName,
        commandId: input.commandId,
      });
      let turnId: string | null = null;
      if (this.platform === "win32") {
        const { threadId: _threadId, ...turnStartParams } = startParameters;
        const response = await this.desktopIpc.startTurn({
          conversationId: input.threadId,
          turnStartParams: {
            ...turnStartParams,
            clientUserMessageId: input.commandId,
            additionalContext: null,
          },
        });
        turnId = nestedTurnId(response);
      } else {
        const response = (await this.request(
          "turn/start",
          startParameters,
        )) as TurnStartResponse;
        turnId = response.turn?.id ?? null;
      }
      if (!turnId) {
        throw new Error("Codex Desktop did not return a started turn id");
      }
      if (stagingDirectory) {
        this.registerStagingDirectory(turnId, stagingDirectory);
        stagingRegistered = true;
      }
      return { status: "submitted", mode: "started", turnId };
    } finally {
      if (stagingDirectory && !stagingRegistered) {
        await rm(stagingDirectory, { recursive: true, force: true });
      }
    }
  }

  async stopPeerPrompt(input: {
    threadId: string;
  }): Promise<CodexPromptSubmission> {
    await this.start();
    let desktopError: unknown = null;
    if (this.platform === "win32") {
      try {
        const result = await this.desktopIpc.interruptTurn({
          conversationId: input.threadId,
          mode: "user-stop",
        });
        if (result.interruptedTurnId) {
          return {
            status: "submitted",
            mode: "interrupted",
            turnId: result.interruptedTurnId,
          };
        }
      } catch (error) {
        desktopError = error;
      }
    }

    const turnId = await this.getActiveTurnId(input.threadId);
    if (!turnId) {
      if (desktopError) throw desktopError;
      return { status: "deferred", reason: "no-active-turn", turnId: null };
    }

    try {
      await this.request("thread/resume", {
        threadId: input.threadId,
        excludeTurns: true,
      });
      await this.request("turn/interrupt", {
        threadId: input.threadId,
        turnId,
      });
      await this.waitForTurnInterruption(input.threadId, turnId);
    } catch (error) {
      if (desktopError) {
        throw new AggregateError(
          [desktopError, error],
          "Codex Desktop IPC and app-server both failed to interrupt the active turn",
        );
      }
      throw error;
    }

    return { status: "submitted", mode: "interrupted", turnId };
  }

  async getTurnStatus(
    threadId: string,
    turnId: string,
  ): Promise<CodexTurnStatus | null> {
    await this.start();
    const response = (await this.request("thread/turns/list", {
      threadId,
      limit: 100,
      sortDirection: "desc",
      itemsView: "summary",
    })) as { data?: CodexTurn[] };
    return response.data?.find((turn) => turn.id === turnId)?.status ?? null;
  }

  private async getActiveTurnId(threadId: string): Promise<string | null> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const response = (await this.request("thread/turns/list", {
          threadId,
          limit: 50,
          sortDirection: "desc",
          itemsView: "summary",
        })) as { data?: CodexTurn[] };
        return response.data?.find((turn) => turn.status === "inProgress")?.id ?? null;
      } catch (error) {
        if (isUnmaterializedThreadError(error)) return null;
        if (isEmptyRolloutError(error) && attempt < 9) {
          await delay(100);
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  private async waitForTurnInterruption(
    threadId: string,
    turnId: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await this.getTurnStatus(threadId, turnId);
      if (
        status === "interrupted" ||
        status === "failed" ||
        status === "completed"
      ) {
        return;
      }
      if (attempt < 19) {
        await delay(100);
      }
    }
    throw new Error(
      `Codex app-server did not confirm interruption of turn ${turnId}`,
    );
  }

  private registerStagingDirectory(turnId: string, path: string): void {
    const paths = this.stagedAttachments.get(turnId) ?? new Set<string>();
    paths.add(path);
    this.stagedAttachments.set(turnId, paths);
    const fallback = setTimeout(() => {
      void this.cleanupStagedAttachments(turnId);
    }, 60 * 60 * 1_000);
    fallback.unref();
  }

  private async cleanupStagedAttachments(turnId: string): Promise<void> {
    const paths = this.stagedAttachments.get(turnId);
    if (!paths) return;
    this.stagedAttachments.delete(turnId);
    await Promise.all(
      [...paths].map((path) => rm(path, { recursive: true, force: true })),
    );
  }

  private async cleanupAllStagedAttachments(): Promise<void> {
    const turnIds = [...this.stagedAttachments.keys()];
    await Promise.all(
      turnIds.map((turnId) => this.cleanupStagedAttachments(turnId)),
    );
  }

  async close(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    await this.desktopIpc.close();
    await this.cleanupAllStagedAttachments();
    this.rolloutActivityCache.clear();
  }

  private async readRolloutActivity(
    path: string,
    size: number,
  ): Promise<CodexRolloutActivity> {
    let cached = this.rolloutActivityCache.get(path);
    if (cached && size < cached.size) {
      cached = undefined;
    }
    let offset = cached?.size ?? 0;
    let pendingLine = cached?.pendingLine ?? "";
    let activity = cached?.activity ?? {
      openTurnIds: [],
      latestObservedTurnId: null,
      latestObservedAtMs: null,
    };
    if (offset >= size) return activity;

    const handle = await openFile(path, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(Math.min(1_048_576, size - offset));
    try {
      while (offset < size) {
        const length = Math.min(buffer.length, size - offset);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          length,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
        pendingLine += decoder.write(buffer.subarray(0, bytesRead));
        const lines = pendingLine.split(/\r?\n/);
        pendingLine = lines.pop() ?? "";
        activity = extractCodexRolloutActivity(lines, activity);
      }
      pendingLine += decoder.end();
    } finally {
      await handle.close();
    }
    this.rolloutActivityCache.set(path, {
      size: offset,
      pendingLine,
      activity,
    });
    return activity;
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
      if (
        message.method === "turn/completed" &&
        message.params &&
        typeof message.params === "object" &&
        "turn" in message.params &&
        message.params.turn &&
        typeof message.params.turn === "object" &&
        "id" in message.params.turn &&
        typeof message.params.turn.id === "string"
      ) {
        void this.cleanupStagedAttachments(message.params.turn.id);
      }
      this.emit("notification", message);
    }
  }
}
