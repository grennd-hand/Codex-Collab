import type {
  CodexRecordEntry,
  WorkspaceHistoryPage,
  WorkspaceHistoryPageItem,
} from "@codex-collab/protocol";

export interface WorkspaceHistoryWindow {
  sessionId: string | null;
  threadId: string | null;
  hostGeneration: string | null;
  items: WorkspaceHistoryPageItem[];
  totalCount: number;
  hasOlder: boolean;
  olderCursor: string | null;
  initialLoading: boolean;
  olderLoading: boolean;
  refreshingLatest: boolean;
  error: string | null;
}

export function createWorkspaceHistoryWindow(
  sessionId: string | null,
  threadId: string | null,
  initialLoading = false,
  hostGeneration: string | null = null,
): WorkspaceHistoryWindow {
  return {
    sessionId,
    threadId,
    hostGeneration,
    items: [],
    totalCount: 0,
    hasOlder: false,
    olderCursor: null,
    initialLoading,
    olderLoading: false,
    refreshingLatest: false,
    error: null,
  };
}

export function beginLatestHistoryLoad(
  current: WorkspaceHistoryWindow,
  sessionId: string,
  threadId: string | null,
  hostGeneration: string | null,
): WorkspaceHistoryWindow {
  if (
    current.sessionId !== sessionId ||
    current.threadId !== threadId ||
    current.hostGeneration !== hostGeneration
  ) {
    return createWorkspaceHistoryWindow(
      sessionId,
      threadId,
      Boolean(threadId),
      hostGeneration,
    );
  }
  return {
    ...current,
    initialLoading: current.items.length === 0 && Boolean(threadId),
    refreshingLatest: current.items.length > 0,
    error: null,
  };
}

export function reconcileLatestHistoryPage(
  current: WorkspaceHistoryWindow,
  sessionId: string,
  hostGeneration: string | null,
  page: WorkspaceHistoryPage,
): WorkspaceHistoryWindow {
  if (
    current.sessionId !== sessionId ||
    current.threadId !== page.selectedThreadId ||
    current.hostGeneration !== hostGeneration
  ) {
    return current;
  }

  let items = page.items;
  let hasOlder = page.hasOlder;
  let olderCursor = page.olderCursor;
  if (current.items.length > 0 && page.items.length > 0) {
    const overlapIndex = current.items.findIndex(
      (item) => item.key === page.items[0]?.key,
    );
    if (overlapIndex >= 0) {
      items = [...current.items.slice(0, overlapIndex), ...page.items];
      if (overlapIndex > 0) {
        hasOlder = current.hasOlder;
        olderCursor = current.olderCursor;
      }
    }
  }

  return {
    ...current,
    items,
    totalCount: page.totalCount,
    hasOlder,
    olderCursor,
    initialLoading: false,
    refreshingLatest: false,
    error: null,
  };
}

export function beginOlderHistoryLoad(
  current: WorkspaceHistoryWindow,
): WorkspaceHistoryWindow {
  if (!current.hasOlder || !current.olderCursor || current.olderLoading) {
    return current;
  }
  return { ...current, olderLoading: true, error: null };
}

export function prependOlderHistoryPage(
  current: WorkspaceHistoryWindow,
  sessionId: string,
  hostGeneration: string | null,
  requestedCursor: string,
  page: WorkspaceHistoryPage,
): WorkspaceHistoryWindow {
  if (
    current.sessionId !== sessionId ||
    current.hostGeneration !== hostGeneration ||
    current.threadId !== page.selectedThreadId ||
    current.olderCursor !== requestedCursor
  ) {
    return current;
  }
  const currentKeys = new Set(current.items.map((item) => item.key));
  const olderItems = page.items.filter((item) => !currentKeys.has(item.key));
  return {
    ...current,
    items: [...olderItems, ...current.items],
    totalCount: page.totalCount,
    hasOlder: page.hasOlder,
    olderCursor: page.olderCursor,
    olderLoading: true,
    error: null,
  };
}

export function finishOlderHistoryLoad(
  current: WorkspaceHistoryWindow,
): WorkspaceHistoryWindow {
  return current.olderLoading ? { ...current, olderLoading: false } : current;
}

export function failHistoryLoad(
  current: WorkspaceHistoryWindow,
  message: string,
): WorkspaceHistoryWindow {
  return {
    ...current,
    initialLoading: false,
    olderLoading: false,
    refreshingLatest: false,
    error: message,
  };
}

export function workspaceHistoryEntries(
  window: WorkspaceHistoryWindow,
): CodexRecordEntry[] {
  return window.items.map((item) => item.entry);
}
