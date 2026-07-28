import {
  MAX_WORKSPACE_HISTORY_ENTRIES,
  MAX_WORKSPACE_HISTORY_TEXT_LENGTH,
  type CodexFileChange,
  type CodexRecordEntry,
} from "@codex-collab/protocol";

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

export const MAX_PUBLISHED_RECORD_ENTRIES = MAX_WORKSPACE_HISTORY_ENTRIES;
export const MAX_PUBLISHED_RECORD_TEXT_LENGTH = MAX_WORKSPACE_HISTORY_TEXT_LENGTH;

function isConversationEntry(entry: CodexRecordEntry): boolean {
  return entry.role === "user" || entry.role === "assistant";
}

export function limitRecordEntries(entries: CodexRecordEntry[]): CodexRecordEntry[] {
  const selectedIndexes = new Set<number>();
  let totalLength = 0;

  const selectNewest = (matches: (entry: CodexRecordEntry) => boolean) => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (selectedIndexes.size >= MAX_PUBLISHED_RECORD_ENTRIES) return;
      const entry = entries[index];
      if (!entry || selectedIndexes.has(index) || !matches(entry)) continue;
      if (totalLength + entry.text.length > MAX_PUBLISHED_RECORD_TEXT_LENGTH) {
        continue;
      }
      selectedIndexes.add(index);
      totalLength += entry.text.length;
    }
  };

  // Preserve the actual conversation before filling the remaining budget with
  // recent reasoning and command details. Long-running tasks can produce
  // thousands of tool records that would otherwise evict every older prompt.
  selectNewest(isConversationEntry);
  selectNewest((entry) => !isConversationEntry(entry));

  return entries.filter((_, index) => selectedIndexes.has(index));
}

export function lineChangeCounts(diff: string): { additions: number; deletions: number } {
  const lines = diff.split(/\r?\n/);
  return {
    additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
  };
}

export function fileChangeKind(type: string): CodexFileChange["kind"] {
  if (type === "add" || type === "added") return "added";
  if (type === "delete" || type === "deleted") return "deleted";
  if (type === "move" || type === "rename" || type === "renamed") {
    return "renamed";
  }
  return "modified";
}

export function fileChangeLifecycle(
  status: string | undefined,
): CodexFileChange["lifecycle"] {
  if (status === "failed") return "failed";
  if (status === "inProgress" || status === "running") return "running";
  return "completed";
}

export function structuredFileChange(
  operationId: string,
  taskId: string | undefined,
  path: string,
  type: string,
  movePath: string | null,
  diff: string,
  lifecycle: CodexFileChange["lifecycle"],
): CodexFileChange {
  const { additions, deletions } = lineChangeCounts(diff);
  const renamed = fileChangeKind(type) === "renamed";
  return {
    operationId,
    ...(taskId ? { taskId } : {}),
    path: (renamed && movePath ? movePath : path).replaceAll("\\", "/"),
    ...(renamed ? { previousPath: path.replaceAll("\\", "/") } : {}),
    kind: fileChangeKind(type),
    lifecycle,
    additions,
    deletions,
  };
}

export function safeFileChangeSummary(
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


export function rolloutText(value: unknown): string {
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

export function rolloutCommandText(
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
