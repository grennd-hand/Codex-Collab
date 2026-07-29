import type {
  Session,
  WorkspaceHistoryPage,
  WorkspaceSummary,
} from "@codex-collab/protocol";
import type { RefObject } from "react";
import { ApiRequestError, requestJson } from "../../../shared/api/api-client.js";
import {
  captureHistoryScrollAnchor,
  type PendingHistoryScrollRestore,
} from "../../timeline/history/history-scroll.js";
import { isWorkspaceRefreshAbort } from "./workspace-refresh.js";
import {
  beginOlderHistoryLoad,
  createWorkspaceHistoryWindow,
  failHistoryLoad,
  finishOlderHistoryLoad,
  prependOlderHistoryPage,
  type WorkspaceHistoryWindow,
} from "./workspace-history-window.js";

type MutableRef<T> = { current: T };

type OlderWorkspaceHistoryOptions = {
  approved: boolean;
  authHeaders: (includeJson?: boolean) => HeadersInit;
  commitHistoryWindow: (
    update: (current: WorkspaceHistoryWindow) => WorkspaceHistoryWindow,
  ) => WorkspaceHistoryWindow;
  historyEpochRef: MutableRef<number>;
  historyWindowRef: MutableRef<WorkspaceHistoryWindow>;
  messageStreamRef: RefObject<HTMLElement | null>;
  onError: (caught: unknown) => void;
  olderAbortRef: MutableRef<AbortController | null>;
  olderRequestIdRef: MutableRef<number>;
  pendingScrollRestoreRef: MutableRef<PendingHistoryScrollRestore | null>;
  prependingRef: MutableRef<boolean>;
  refresh: (includeHistory?: boolean) => Promise<WorkspaceSummary | null>;
  session: Session | null;
  sessionIdRef: MutableRef<string | null>;
  token: string | null;
};

type OlderRequestIdentity = {
  historyEpoch: number;
  hostGeneration: string | null;
  requestId: number;
  requestedCursor: string;
  sessionId: string;
  threadId: string;
};

function isActiveRequest(
  options: OlderWorkspaceHistoryOptions,
  request: OlderRequestIdentity,
) {
  return (
    options.sessionIdRef.current === request.sessionId &&
    options.historyEpochRef.current === request.historyEpoch &&
    options.olderRequestIdRef.current === request.requestId
  );
}

function matchesRequestedWindow(
  window: WorkspaceHistoryWindow,
  request: OlderRequestIdentity,
) {
  return (
    window.sessionId === request.sessionId &&
    window.threadId === request.threadId &&
    window.hostGeneration === request.hostGeneration &&
    window.olderCursor === request.requestedCursor
  );
}

function handleOlderHistoryError(
  options: OlderWorkspaceHistoryOptions,
  request: OlderRequestIdentity,
  caught: unknown,
) {
  if (isWorkspaceRefreshAbort(caught)) return;
  const { commitHistoryWindow, historyWindowRef, onError, refresh } = options;
  if (
    !isActiveRequest(options, request) ||
    historyWindowRef.current.threadId !== request.threadId ||
    historyWindowRef.current.hostGeneration !== request.hostGeneration
  ) {
    return;
  }
  if (caught instanceof ApiRequestError && caught.code === "history_cursor_stale") {
    commitHistoryWindow(() =>
      createWorkspaceHistoryWindow(
        request.sessionId,
        request.threadId,
        true,
        request.hostGeneration,
      ),
    );
    void refresh(true).catch(onError);
    return;
  }
  const message = caught instanceof Error ? caught.message : "更早记录加载失败";
  commitHistoryWindow((window) => failHistoryLoad(window, message));
}

export async function loadOlderWorkspaceHistory(
  options: OlderWorkspaceHistoryOptions,
): Promise<void> {
  const {
    approved,
    authHeaders,
    commitHistoryWindow,
    historyEpochRef,
    historyWindowRef,
    messageStreamRef,
    onError,
    olderAbortRef,
    olderRequestIdRef,
    pendingScrollRestoreRef,
    prependingRef,
    refresh,
    session,
    sessionIdRef,
    token,
  } = options;
  const current = historyWindowRef.current;
  if (
    !session ||
    !token ||
    !approved ||
    !current.threadId ||
    !current.hasOlder ||
    !current.olderCursor ||
    current.olderLoading ||
    olderAbortRef.current
  ) {
    return;
  }
  const sessionId = session.id;
  const threadId = current.threadId;
  const hostGeneration = current.hostGeneration;
  const requestedCursor = current.olderCursor;
  const historyEpoch = historyEpochRef.current;
  const requestId = ++olderRequestIdRef.current;
  const identity = {
    historyEpoch,
    hostGeneration,
    requestId,
    requestedCursor,
    sessionId,
    threadId,
  } satisfies OlderRequestIdentity;
  const anchor = captureHistoryScrollAnchor(messageStreamRef.current);
  const controller = new AbortController();
  let restoreScheduled = false;
  olderAbortRef.current = controller;
  prependingRef.current = true;
  commitHistoryWindow(beginOlderHistoryLoad);
  try {
    const result = await requestJson<{ workspaceHistoryPage: WorkspaceHistoryPage }>(
      `/v1/sessions/${sessionId}/workspace/history/page?limit=40&before=${encodeURIComponent(requestedCursor)}`,
      { headers: authHeaders(), signal: controller.signal },
    );
    if (
      !isActiveRequest(options, identity) ||
      result.workspaceHistoryPage.selectedThreadId !== threadId
    ) {
      return;
    }
    const latest = historyWindowRef.current;
    if (!matchesRequestedWindow(latest, identity)) return;
    const next = prependOlderHistoryPage(
      latest,
      sessionId,
      hostGeneration,
      requestedCursor,
      result.workspaceHistoryPage,
    );
    if (next === latest) return;
    pendingScrollRestoreRef.current = {
      sessionId,
      threadId,
      hostGeneration,
      historyEpoch,
      requestId,
      anchor,
    };
    restoreScheduled = true;
    commitHistoryWindow(() => next);
  } catch (caught) {
    handleOlderHistoryError(options, identity, caught);
  } finally {
    if (olderRequestIdRef.current === requestId && !restoreScheduled) {
      commitHistoryWindow(finishOlderHistoryLoad);
      prependingRef.current = false;
      if (olderAbortRef.current === controller) olderAbortRef.current = null;
    }
  }
}
