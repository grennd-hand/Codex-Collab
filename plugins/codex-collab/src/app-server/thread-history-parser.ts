import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import {
  sanitizeCodexAssistantMessageText,
  sanitizeCodexUserMessageText,
  type CodexFileChange,
  type CodexRecordEntry,
} from "@codex-collab/protocol";
import {
  fileChangeLifecycle,
  limitRecordEntries,
  redactSensitiveText,
  rolloutCommandText,
  safeFileChangeSummary,
  structuredFileChange,
} from "./history-common.js";

export interface CodexThreadSummary {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string | null;
  status?: unknown;
  updatedAt?: number;
  path?: string | null;
}

interface RolloutItem {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
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

export interface CodexThreadItem {
  type: string;
  id?: string;
  clientId?: string | null;
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

export interface CodexTurn {
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

function containsCollabCommandId(
  value: unknown,
  commandId: string,
  depth = 0,
): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsCollabCommandId(entry, commandId, depth + 1));
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "collab_command_id" && entry === commandId) return true;
    if (containsCollabCommandId(entry, commandId, depth + 1)) return true;
  }
  return false;
}

export function turnMatchesPeerCommand(turn: CodexTurn, commandId: string): boolean {
  return turn.items.some(
    (item) =>
      (item.type === "userMessage" && item.clientId === commandId) ||
      containsCollabCommandId(item, commandId),
  );
}

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
  turns: ReadonlyArray<{
    id: string;
    status?: CodexTurnStatus;
    startedAt?: number | null;
  }>,
  nowMs = Date.now(),
): boolean {
  if (
    activity.latestObservedTurnId &&
    !activity.openTurnIds.includes(activity.latestObservedTurnId)
  ) {
    return turns.some(
      (turn) =>
        turn.status === "inProgress" &&
        turn.id !== activity.latestObservedTurnId &&
        (typeof turn.startedAt === "number" &&
        Number.isFinite(turn.startedAt) &&
        activity.latestObservedAtMs !== null
          ? turn.startedAt * 1_000 > activity.latestObservedAtMs
          : turn.id > activity.latestObservedTurnId!),
    );
  }
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

function appServerFileChanges(
  item: CodexThreadItem,
  taskId?: string,
): CodexFileChange[] {
  const lifecycle = fileChangeLifecycle(item.status);
  return (item.changes ?? []).flatMap((change, index) => {
    if (typeof change.path !== "string" || !change.path.trim()) return [];
    return [
      structuredFileChange(
        `${item.id ?? "file-change"}:${index}`,
        taskId,
        change.path.trim(),
        change.kind?.type ?? "update",
        change.kind?.move_path ?? null,
        change.diff ?? "",
        lifecycle,
      ),
    ];
  });
}

export function extractCodexRecordEntries(
  turns: CodexTurn[],
  taskId?: string,
): CodexRecordEntry[] {
  const entries: CodexRecordEntry[] = [];
  for (const turn of turns) {
    const createdAt =
      typeof turn.startedAt === "number"
        ? new Date(turn.startedAt * 1_000).toISOString()
        : null;
    for (const item of turn.items) {
      let role: CodexRecordEntry["role"] | null = null;
      let value = "";
      let fileChanges: CodexFileChange[] | undefined;
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
        fileChanges = appServerFileChanges(item, taskId);
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
        ...(fileChanges?.length ? { fileChanges } : {}),
      });
    }
  }

  return limitRecordEntries(entries);
}
