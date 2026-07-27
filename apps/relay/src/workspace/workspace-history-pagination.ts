import { createHash } from "node:crypto";
import {
  type CodexRecordEntry,
  type WorkspaceHistoryPage,
  ProtocolError,
} from "@codex-collab/protocol";

export const DEFAULT_WORKSPACE_HISTORY_PAGE_SIZE = 40;
export const MAX_WORKSPACE_HISTORY_PAGE_SIZE = 100;

interface WorkspaceHistoryCursor {
  version: 1;
  sessionId: string;
  threadId: string;
  anchorKey: string;
  anchorFingerprint: string;
}

export interface PaginateWorkspaceHistoryOptions {
  sessionId: string;
  threadId: string;
  history: CodexRecordEntry[];
  syncedAt: string | null;
  limit?: number | undefined;
  before?: string | null | undefined;
}

function historyEntryFingerprint(entry: CodexRecordEntry): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("base64url");
}

function workspaceHistoryPageItems(history: CodexRecordEntry[]) {
  const occurrences = new Map<string, number>();
  const items = history.map((entry) => {
    const occurrence = (occurrences.get(entry.id) ?? 0) + 1;
    occurrences.set(entry.id, occurrence);
    return {
      key: `${createHash("sha256").update(entry.id).digest("base64url")}:${occurrence}`,
      entry,
    };
  });

  let executionGroupKey: string | null = null;
  return items.map((item) => {
    const isExecutionEntry =
      item.entry.role === "reasoning" ||
      item.entry.role === "command" ||
      (item.entry.role === "assistant" && item.entry.phase === "commentary");
    if (!isExecutionEntry) {
      executionGroupKey = null;
      return { ...item, groupKey: null };
    }
    executionGroupKey ??= `execution-${item.key}`;
    return { ...item, groupKey: executionGroupKey };
  });
}

function encodeWorkspaceHistoryCursor(
  sessionId: string,
  threadId: string,
  anchorKey: string,
  entry: CodexRecordEntry,
): string {
  const payload: WorkspaceHistoryCursor = {
    version: 1,
    sessionId,
    threadId,
    anchorKey,
    anchorFingerprint: historyEntryFingerprint(entry),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeWorkspaceHistoryCursor(cursor: string): WorkspaceHistoryCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<WorkspaceHistoryCursor>;
    if (
      parsed.version !== 1 ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.threadId !== "string" ||
      typeof parsed.anchorKey !== "string" ||
      typeof parsed.anchorFingerprint !== "string"
    ) {
      throw new Error("invalid cursor payload");
    }
    return parsed as WorkspaceHistoryCursor;
  } catch {
    throw new ProtocolError(
      400,
      "invalid_history_cursor",
      "The history cursor is invalid",
    );
  }
}

export function paginateWorkspaceHistory({
  sessionId,
  threadId,
  history,
  syncedAt,
  limit = DEFAULT_WORKSPACE_HISTORY_PAGE_SIZE,
  before,
}: PaginateWorkspaceHistoryOptions): WorkspaceHistoryPage {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_WORKSPACE_HISTORY_PAGE_SIZE
  ) {
    throw new ProtocolError(
      400,
      "invalid_history_page_limit",
      `History page limit must be between 1 and ${MAX_WORKSPACE_HISTORY_PAGE_SIZE}`,
    );
  }

  const allItems = workspaceHistoryPageItems(history);
  let end = allItems.length;
  if (before) {
    const cursor = decodeWorkspaceHistoryCursor(before);
    if (cursor.sessionId !== sessionId || cursor.threadId !== threadId) {
      throw new ProtocolError(
        409,
        "history_cursor_stale",
        "The selected Codex task changed while loading history",
      );
    }
    const anchorIndex = allItems.findIndex(
      (item) =>
        item.key === cursor.anchorKey &&
        historyEntryFingerprint(item.entry) === cursor.anchorFingerprint,
    );
    if (anchorIndex < 0) {
      throw new ProtocolError(
        409,
        "history_cursor_stale",
        "The Codex history changed while loading older records",
      );
    }
    end = anchorIndex;
  }

  const start = Math.max(0, end - limit);
  const items = allItems.slice(start, end);
  const hasOlder = start > 0;
  return {
    selectedThreadId: threadId,
    items,
    totalCount: allItems.length,
    hasOlder,
    olderCursor:
      hasOlder && items[0]
        ? encodeWorkspaceHistoryCursor(
            sessionId,
            threadId,
            items[0].key,
            items[0].entry,
          )
        : null,
    syncedAt,
  };
}
