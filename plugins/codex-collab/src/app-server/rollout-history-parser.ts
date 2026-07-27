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
  rolloutText,
  safeFileChangeSummary,
  structuredFileChange,
} from "./history-common.js";

interface RolloutItem {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
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

function rolloutPatchChanges(
  payload: Record<string, unknown>,
  taskId: string,
  operationId: string,
  lifecycle: CodexFileChange["lifecycle"],
): CodexFileChange[] {
  if (!payload.changes || typeof payload.changes !== "object") return [];
  return Object.entries(payload.changes as Record<string, unknown>).flatMap(
    ([path, rawChange], index) => {
      if (!rawChange || typeof rawChange !== "object") return [];
      const change = rawChange as Record<string, unknown>;
      const type = typeof change.type === "string" ? change.type : "update";
      const diff = typeof change.unified_diff === "string" ? change.unified_diff : "";
      const movePath = typeof change.move_path === "string" ? change.move_path : null;
      return [
        structuredFileChange(
          `${operationId}:${index}`,
          taskId,
          path,
          type,
          movePath,
          diff,
          lifecycle,
        ),
      ];
    },
  );
}

function safeApplyPatchFileChanges(
  input: string,
  taskId: string,
  operationId: string,
): CodexFileChange[] {
  return input.split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^\*\*\*\s+(Add|Update|Delete|Move) File:\s+(.+)$/);
    if (!match?.[1] || !match[2]) return [];
    return [
      structuredFileChange(
        `${operationId}:${index}`,
        taskId,
        match[2].trim(),
        match[1].toLowerCase(),
        null,
        "",
        "running",
      ),
    ];
  });
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
      fileChanges?: CodexFileChange[];
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
      const lifecycle: CodexFileChange["lifecycle"] = success ? "completed" : "failed";
      const fileChanges = rolloutPatchChanges(
        payload,
        threadId,
        callId || `${threadId}-patch-${entries.length}`,
        lifecycle,
      );
      const output = [rolloutText(payload.stdout), rolloutText(payload.stderr)]
        .map((value) => value.trim())
        .filter(Boolean)
        .join("\n");
      const pendingCall = callId ? commandCalls.get(callId) : null;
      if (pendingCall && input) {
        pendingCall.input = input;
        pendingCall.status = status;
        pendingCall.output = output;
        pendingCall.fileChanges = fileChanges;
      } else if (input) {
        const text = redactSensitiveText(rolloutCommandText("apply_patch", status, input, output));
        entries.push({
          id: `${threadId}-patch-${callId || entries.length}`,
          role: "command",
          text: text.slice(0, 50_000),
          createdAt,
          ...(fileChanges.length ? { fileChanges } : {}),
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
        ...(name === "apply_patch"
          ? { fileChanges: safeApplyPatchFileChanges(rolloutText(payload.arguments ?? payload.input), threadId, callId) }
          : {}),
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
      const status = call.status ?? "completed";
      const fileChanges = call.fileChanges?.map((change) => ({
        ...change,
        lifecycle: status === "failed" ? "failed" as const : "completed" as const,
      }));
      if (text) {
        entries.push({
          id: call.id,
          role: "command",
          text: text.slice(0, 50_000),
          createdAt: call.createdAt ?? createdAt,
          ...(fileChanges?.length ? { fileChanges } : {}),
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
      ...(call.fileChanges?.length ? { fileChanges: call.fileChanges } : {}),
    });
  }
  return limitRecordEntries(entries);
}


