import type { CodexFileChange, CodexRecordEntry } from "@codex-collab/protocol";
import type { ExecutionStatus } from "./execution-presentation-types.js";

export function legacyFileChanges(
  entry: CodexRecordEntry,
  tool: string,
  input: string | null,
  status: ExecutionStatus,
): CodexFileChange[] {
  if (entry.fileChanges?.length) return entry.fileChanges;
  if (tool !== "apply_patch" || !input) return [];
  const lifecycle: CodexFileChange["lifecycle"] =
    status === "running" ? "running" : status === "failed" ? "failed" : "completed";
  return input.split(/\r?\n/).flatMap((line, index) => {
    const counts = line.match(/（\+(\d+)\s+-(\d+)）$/);
    const normalized = line.replace(/（\+\d+\s+-\d+）$/, "").trim();
    const summary = normalized.match(/^(新增|修改|删除|移动)\s+(.+)$/);
    const patch = normalized.match(/^\*\*\*\s+(Add|Update|Delete|Move) File:\s+(.+)$/);
    if (!summary && !patch) return [];
    const operation = summary?.[1] ?? patch?.[1] ?? "修改";
    const rawPath = (summary?.[2] ?? patch?.[2] ?? "").trim();
    const moveParts = rawPath.split(/\s+→\s+/);
    const kind: CodexFileChange["kind"] =
      operation === "新增" || operation === "Add"
        ? "added"
        : operation === "删除" || operation === "Delete"
          ? "deleted"
          : operation === "移动" || operation === "Move"
            ? "renamed"
            : "modified";
    const path = (kind === "renamed" ? moveParts[1] ?? moveParts[0] : moveParts[0])
      ?.replaceAll("\\", "/")
      .trim();
    if (!path) return [];
    return [
      {
        operationId: `${entry.id}:${index}`,
        path,
        ...(kind === "renamed" && moveParts[0]
          ? { previousPath: moveParts[0].replaceAll("\\", "/").trim() }
          : {}),
        kind,
        lifecycle,
        additions: Number(counts?.[1] ?? 0),
        deletions: Number(counts?.[2] ?? 0),
      },
    ];
  });
}

