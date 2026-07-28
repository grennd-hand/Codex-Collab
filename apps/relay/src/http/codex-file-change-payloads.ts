import {
  MAX_CODEX_FILE_CHANGE_DIFF_LENGTH,
  ProtocolError,
  codexConfigRelativePath,
  containsLikelySecret,
  isPublishableCodexConfigPath,
  isPublishableWorkspacePath,
  optionalInteger,
  requiredString,
  type CodexFileChange,
  type CodexFileChangeDiff,
} from "@codex-collab/protocol";

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "invalid_request", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseOptionalSha256(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const sha256 = requiredString(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new ProtocolError(400, "invalid_request", `${field} must be a SHA-256 hash or null`);
  }
  return sha256;
}

function parseOptionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ProtocolError(400, "invalid_request", `${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function pathCanIncludeDiff(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return false;
  }
  const configPath = codexConfigRelativePath(normalized);
  return isPublishableWorkspacePath(normalized) || Boolean(
    configPath && isPublishableCodexConfigPath(configPath),
  );
}

function parseActor(value: unknown, field: string): CodexFileChange["actor"] {
  if (value === undefined) return undefined;
  const actor = requiredObject(value, field);
  if (
    actor.type !== "codex" &&
    actor.type !== "owner" &&
    actor.type !== "member" &&
    actor.type !== "host"
  ) {
    throw new ProtocolError(400, "invalid_request", `${field}.type is invalid`);
  }
  return {
    type: actor.type,
    ...(typeof actor.id === "string" && actor.id.trim()
      ? { id: requiredString(actor.id, `${field}.id`, 160) }
      : {}),
    ...(typeof actor.displayName === "string" && actor.displayName.trim()
      ? { displayName: requiredString(actor.displayName, `${field}.displayName`, 200) }
      : {}),
  };
}

function parseRange(value: unknown, field: string): CodexFileChange["range"] {
  if (value === undefined) return undefined;
  const range = requiredObject(value, field);
  if (range.startLine === undefined || range.endLine === undefined) {
    throw new ProtocolError(
      400,
      "invalid_request",
      `${field}.startLine and ${field}.endLine are required`,
    );
  }
  const startLine = optionalInteger(range.startLine, 0, `${field}.startLine`, 1, 10_000_000);
  const endLine = optionalInteger(range.endLine, 0, `${field}.endLine`, 1, 10_000_000);
  const startColumn = range.startColumn === undefined
    ? undefined
    : optionalInteger(range.startColumn, 1, `${field}.startColumn`, 1, 1_000_000);
  const endColumn = range.endColumn === undefined
    ? undefined
    : optionalInteger(range.endColumn, 1, `${field}.endColumn`, 1, 1_000_000);
  if (
    endLine < startLine ||
    (endLine === startLine && startColumn !== undefined && endColumn !== undefined && endColumn < startColumn)
  ) {
    throw new ProtocolError(400, "invalid_request", `${field} must end at or after its start`);
  }
  return {
    startLine,
    ...(startColumn === undefined ? {} : { startColumn }),
    endLine,
    ...(endColumn === undefined ? {} : { endColumn }),
  };
}

function parseDiff(
  value: unknown,
  field: string,
  path: string,
  previousPath: string | null,
): CodexFileChangeDiff | undefined {
  if (value === undefined) return undefined;
  const diff = typeof value === "string"
    ? { format: "unified", text: value, truncated: false }
    : requiredObject(value, field);
  if (
    diff.format !== "unified" ||
    typeof diff.text !== "string" ||
    typeof diff.truncated !== "boolean"
  ) {
    throw new ProtocolError(400, "invalid_request", `${field} is invalid`);
  }
  if (
    diff.text.length > MAX_CODEX_FILE_CHANGE_DIFF_LENGTH ||
    diff.text.includes("\0") ||
    containsLikelySecret(diff.text) ||
    !pathCanIncludeDiff(path) ||
    (previousPath !== null && !pathCanIncludeDiff(previousPath))
  ) {
    throw new ProtocolError(400, "unsafe_file_change_diff", `${field} is not safe to share`);
  }
  return { format: "unified", text: diff.text, truncated: diff.truncated };
}

export function parseCodexFileChanges(
  value: unknown,
  entryIndex: number,
): CodexFileChange[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    throw new ProtocolError(
      400,
      "invalid_request",
      `history[${entryIndex}].fileChanges must contain at most 100 entries`,
    );
  }
  return value.map((item, changeIndex) => {
    const field = `history[${entryIndex}].fileChanges[${changeIndex}]`;
    const record = requiredObject(item, field);
    if (
      record.kind !== "added" &&
      record.kind !== "modified" &&
      record.kind !== "deleted" &&
      record.kind !== "renamed"
    ) {
      throw new ProtocolError(400, "invalid_request", `${field}.kind is invalid`);
    }
    if (
      record.lifecycle !== "running" &&
      record.lifecycle !== "completed" &&
      record.lifecycle !== "failed"
    ) {
      throw new ProtocolError(400, "invalid_request", `${field}.lifecycle is invalid`);
    }
    const path = requiredString(record.path, `${field}.path`, 500);
    const previousPath = typeof record.previousPath === "string" && record.previousPath.trim()
      ? requiredString(record.previousPath, `${field}.previousPath`, 500)
      : null;
    if (path.includes("\0") || previousPath?.includes("\0")) {
      throw new ProtocolError(400, "invalid_request", `${field} contains an invalid path`);
    }
    const actor = parseActor(record.actor, `${field}.actor`);
    const timestamp = parseOptionalTimestamp(record.timestamp, `${field}.timestamp`);
    const range = parseRange(record.range, `${field}.range`);
    const beforeSha256 = parseOptionalSha256(record.beforeSha256, `${field}.beforeSha256`);
    const afterSha256 = parseOptionalSha256(record.afterSha256, `${field}.afterSha256`);
    const diff = parseDiff(record.diff, `${field}.diff`, path, previousPath);
    return {
      operationId: requiredString(record.operationId, `${field}.operationId`, 180),
      ...(typeof record.taskId === "string" && record.taskId.trim()
        ? { taskId: requiredString(record.taskId, `${field}.taskId`, 160) }
        : {}),
      ...(actor === undefined ? {} : { actor }),
      ...(timestamp === undefined ? {} : { timestamp }),
      path,
      ...(previousPath ? { previousPath } : {}),
      kind: record.kind,
      lifecycle: record.lifecycle,
      additions: optionalInteger(record.additions, 0, `${field}.additions`, 0, 1_000_000),
      deletions: optionalInteger(record.deletions, 0, `${field}.deletions`, 0, 1_000_000),
      ...(record.line === undefined
        ? {}
        : { line: optionalInteger(record.line, 1, `${field}.line`, 1, 10_000_000) }),
      ...(record.column === undefined
        ? {}
        : { column: optionalInteger(record.column, 1, `${field}.column`, 1, 1_000_000) }),
      ...(range === undefined ? {} : { range }),
      ...(beforeSha256 === undefined ? {} : { beforeSha256 }),
      ...(afterSha256 === undefined ? {} : { afterSha256 }),
      ...(diff === undefined ? {} : { diff }),
    };
  });
}
