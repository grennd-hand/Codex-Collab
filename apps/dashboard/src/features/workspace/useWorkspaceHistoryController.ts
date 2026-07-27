import type {
  Session,
  WorkspaceHistoryPage,
  WorkspaceOverview,
  WorkspaceSummary,
} from "@codex-collab/protocol";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { isWorkspaceRefreshAbort, shouldApplyWorkspaceResponse } from "../../app/workspace-refresh.js";
import {
  beginLatestHistoryLoad,
  beginOlderHistoryLoad,
  createWorkspaceHistoryWindow,
  failHistoryLoad,
  finishOlderHistoryLoad,
  prependOlderHistoryPage,
  reconcileLatestHistoryPage,
  type WorkspaceHistoryWindow,
} from "../../app/workspace-history-window.js";
import { mergeWorkspaceOverview } from "../../app/workspace-state.js";
import { workspaceNeedsConversationLoad } from "../composer/codex-controls.js";
import {
  captureHistoryScrollAnchor,
  restoreHistoryScrollAnchor,
  type PendingHistoryScrollRestore,
} from "../timeline/history-scroll.js";
import { ApiRequestError, requestJson } from "../../shared/api/api-client.js";

type WorkspaceHistoryControllerOptions = {
  approved: boolean;
  authHeaders: (includeJson?: boolean) => HeadersInit;
  messageStreamRef: RefObject<HTMLElement | null>;
  onError: (caught: unknown) => void;
  session: Session | null;
  setConversationLoading: (loading: boolean) => void;
  token: string | null;
};

export function useWorkspaceHistoryController({
  approved,
  authHeaders,
  messageStreamRef,
  onError,
  session,
  setConversationLoading,
  token,
}: WorkspaceHistoryControllerOptions) {
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const [historyWindow, setHistoryWindow] = useState(() =>
    createWorkspaceHistoryWindow(null, null),
  );
  const historyWindowRef = useRef(historyWindow);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const refreshSequenceRef = useRef(0);
  const appliedSequenceRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<WorkspaceSummary | null> | null>(null);
  const refreshIncludesHistoryRef = useRef(false);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const olderAbortRef = useRef<AbortController | null>(null);
  const prependingRef = useRef(false);
  const historyEpochRef = useRef(0);
  const olderRequestIdRef = useRef(0);
  const pendingScrollRestoreRef = useRef<PendingHistoryScrollRestore | null>(null);
  const priorityFileReadsRef = useRef(0);
  const refreshPendingRef = useRef(false);
  const refreshResumeTimerRef = useRef<number | undefined>(undefined);
  const historyRequestedAtRef = useRef(0);

  sessionIdRef.current = session?.id ?? null;
  historyWindowRef.current = historyWindow;

  const commitHistoryWindow = useCallback(
    (update: (current: WorkspaceHistoryWindow) => WorkspaceHistoryWindow) => {
      const next = update(historyWindowRef.current);
      historyWindowRef.current = next;
      setHistoryWindow(next);
      return next;
    },
    [],
  );

  const cancelRequests = useCallback(() => {
    historyEpochRef.current += 1;
    olderRequestIdRef.current += 1;
    refreshSequenceRef.current += 1;
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = null;
    refreshInFlightRef.current = null;
    refreshIncludesHistoryRef.current = false;
    olderAbortRef.current?.abort();
    olderAbortRef.current = null;
    pendingScrollRestoreRef.current = null;
    prependingRef.current = false;
  }, []);

  const reset = useCallback(() => {
    cancelRequests();
    priorityFileReadsRef.current = 0;
    refreshPendingRef.current = false;
    historyRequestedAtRef.current = 0;
    if (refreshResumeTimerRef.current !== undefined) {
      window.clearTimeout(refreshResumeTimerRef.current);
      refreshResumeTimerRef.current = undefined;
    }
    setSummary(null);
    commitHistoryWindow(() => createWorkspaceHistoryWindow(null, null));
  }, [cancelRequests, commitHistoryWindow]);

  useEffect(() => reset(), [reset, session?.id]);

  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    if (!pending) return;
    if (
      olderRequestIdRef.current === pending.requestId &&
      historyWindowRef.current.olderLoading
    ) {
      // Remove the loading row first, then restore against the final geometry in
      // the following layout pass. Restoring before this state change makes the
      // viewport jump when the final page no longer has an older-page control.
      commitHistoryWindow(finishOlderHistoryLoad);
      return;
    }
    pendingScrollRestoreRef.current = null;
    if (
      sessionIdRef.current === pending.sessionId &&
      historyEpochRef.current === pending.historyEpoch &&
      olderRequestIdRef.current === pending.requestId &&
      historyWindowRef.current.threadId === pending.threadId
    ) {
      restoreHistoryScrollAnchor(messageStreamRef.current, pending.anchor);
    }
    if (olderRequestIdRef.current === pending.requestId) {
      prependingRef.current = false;
      olderAbortRef.current = null;
    }
  }, [commitHistoryWindow, historyWindow, messageStreamRef]);

  const refresh = useCallback(async (includeHistory = true) => {
    if (!session || !token || !approved) return null;
    if (priorityFileReadsRef.current > 0) {
      refreshPendingRef.current = true;
      return null;
    }
    const inFlight = refreshInFlightRef.current;
    if (inFlight) {
      if (!includeHistory || refreshIncludesHistoryRef.current) return inFlight;
      refreshAbortRef.current?.abort();
      refreshInFlightRef.current = null;
    }

    const sessionId = session.id;
    const historyEpoch = historyEpochRef.current;
    const requestSequence = ++refreshSequenceRef.current;
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    refreshIncludesHistoryRef.current = includeHistory;
    refreshPendingRef.current = false;
    const request = (async (): Promise<WorkspaceSummary | null> => {
      const result = await requestJson<{ workspace: WorkspaceOverview }>(
        `/v1/sessions/${sessionId}/workspace/overview`,
        { headers: authHeaders(), signal: controller.signal },
      );
      const overview = result.workspace;
      if (
        sessionIdRef.current !== sessionId ||
        historyEpochRef.current !== historyEpoch ||
        !shouldApplyWorkspaceResponse(requestSequence, appliedSequenceRef.current)
      ) {
        return null;
      }
      appliedSequenceRef.current = requestSequence;
      let overviewSummary: WorkspaceSummary = { ...overview, history: [] };
      setSummary((current) => {
        overviewSummary = mergeWorkspaceOverview(current, overview);
        return overviewSummary;
      });
      if (!includeHistory || priorityFileReadsRef.current > 0) return overviewSummary;
      if (!overview.selectedThreadId) {
        commitHistoryWindow(() => createWorkspaceHistoryWindow(sessionId, null));
        setConversationLoading(false);
        return overviewSummary;
      }
      commitHistoryWindow((current) =>
        beginLatestHistoryLoad(current, sessionId, overview.selectedThreadId),
      );
      try {
        const historyResult = await requestJson<{
          workspaceHistoryPage: WorkspaceHistoryPage;
        }>(`/v1/sessions/${sessionId}/workspace/history/page?limit=40`, {
          headers: authHeaders(),
          signal: controller.signal,
        });
        const page = historyResult.workspaceHistoryPage;
        if (
          sessionIdRef.current === sessionId &&
          historyEpochRef.current === historyEpoch &&
          appliedSequenceRef.current === requestSequence &&
          page.selectedThreadId === overview.selectedThreadId
        ) {
          commitHistoryWindow((current) =>
            reconcileLatestHistoryPage(current, sessionId, page),
          );
          setConversationLoading(
            workspaceNeedsConversationLoad({
              ...overview,
              syncedAt: page.syncedAt ?? overview.syncedAt,
            }),
          );
          historyRequestedAtRef.current = Date.now();
        }
      } catch (caught) {
        if (isWorkspaceRefreshAbort(caught)) throw caught;
        if (
          sessionIdRef.current !== sessionId ||
          historyEpochRef.current !== historyEpoch ||
          appliedSequenceRef.current !== requestSequence
        ) {
          return null;
        }
        const message = caught instanceof Error ? caught.message : "最近对话记录加载失败";
        commitHistoryWindow((current) => failHistoryLoad(current, message));
        setConversationLoading(false);
      }
      return overviewSummary;
    })()
      .catch((caught: unknown) => {
        if (isWorkspaceRefreshAbort(caught)) return null;
        throw caught;
      })
      .finally(() => {
        if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
        if (refreshInFlightRef.current === request) {
          refreshInFlightRef.current = null;
          refreshIncludesHistoryRef.current = false;
        }
      });
    refreshInFlightRef.current = request;
    return request;
  }, [
    approved,
    authHeaders,
    commitHistoryWindow,
    session,
    setConversationLoading,
    token,
  ]);

  const loadOlder = useCallback(async () => {
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
    const requestedCursor = current.olderCursor;
    const historyEpoch = historyEpochRef.current;
    const requestId = ++olderRequestIdRef.current;
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
        sessionIdRef.current !== sessionId ||
        historyEpochRef.current !== historyEpoch ||
        olderRequestIdRef.current !== requestId ||
        result.workspaceHistoryPage.selectedThreadId !== threadId
      ) {
        return;
      }
      const latest = historyWindowRef.current;
      if (
        latest.sessionId !== sessionId ||
        latest.threadId !== threadId ||
        latest.olderCursor !== requestedCursor
      ) {
        return;
      }
      const next = prependOlderHistoryPage(
        latest,
        sessionId,
        requestedCursor,
        result.workspaceHistoryPage,
      );
      if (next === latest) return;
      pendingScrollRestoreRef.current = {
        sessionId,
        threadId,
        historyEpoch,
        requestId,
        anchor,
      };
      restoreScheduled = true;
      commitHistoryWindow(() => next);
    } catch (caught) {
      if (isWorkspaceRefreshAbort(caught)) return;
      if (
        sessionIdRef.current !== sessionId ||
        historyEpochRef.current !== historyEpoch ||
        olderRequestIdRef.current !== requestId ||
        historyWindowRef.current.threadId !== threadId
      ) {
        return;
      }
      if (caught instanceof ApiRequestError && caught.code === "history_cursor_stale") {
        commitHistoryWindow(() =>
          createWorkspaceHistoryWindow(sessionId, threadId, true),
        );
        void refresh(true).catch(onError);
        return;
      }
      const message = caught instanceof Error ? caught.message : "更早记录加载失败";
      commitHistoryWindow((window) => failHistoryLoad(window, message));
    } finally {
      if (olderRequestIdRef.current === requestId) {
        if (!restoreScheduled) {
          commitHistoryWindow(finishOlderHistoryLoad);
          prependingRef.current = false;
          if (olderAbortRef.current === controller) olderAbortRef.current = null;
        }
      }
    }
  }, [
    approved,
    authHeaders,
    commitHistoryWindow,
    messageStreamRef,
    onError,
    refresh,
    session,
    token,
  ]);

  const beginPriorityFileRead = useCallback(() => {
    priorityFileReadsRef.current += 1;
    refreshPendingRef.current = true;
    if (refreshResumeTimerRef.current !== undefined) {
      window.clearTimeout(refreshResumeTimerRef.current);
      refreshResumeTimerRef.current = undefined;
    }
    refreshAbortRef.current?.abort();
  }, []);

  const endPriorityFileRead = useCallback(() => {
    priorityFileReadsRef.current = Math.max(0, priorityFileReadsRef.current - 1);
    if (
      priorityFileReadsRef.current > 0 ||
      !refreshPendingRef.current ||
      refreshResumeTimerRef.current !== undefined
    ) {
      return;
    }
    const attempt = () => {
      if (priorityFileReadsRef.current > 0) {
        refreshResumeTimerRef.current = undefined;
        return;
      }
      if (refreshInFlightRef.current) {
        refreshResumeTimerRef.current = window.setTimeout(attempt, 100);
        return;
      }
      refreshResumeTimerRef.current = undefined;
      refreshPendingRef.current = false;
      void refresh().catch(onError);
    };
    refreshResumeTimerRef.current = window.setTimeout(attempt, 300);
  }, [onError, refresh]);

  const prepareThreadSelection = useCallback(() => {
    cancelRequests();
  }, [cancelRequests]);

  const applyThreadSelection = useCallback(
    (workspace: WorkspaceSummary, sessionId: string, threadId: string) => {
      setSummary({ ...workspace, history: [] });
      commitHistoryWindow(() =>
        createWorkspaceHistoryWindow(sessionId, threadId, true),
      );
      setConversationLoading(workspaceNeedsConversationLoad(workspace));
    },
    [commitHistoryWindow, setConversationLoading],
  );

  return {
    applyThreadSelection,
    beginPriorityFileRead,
    endPriorityFileRead,
    historyRequestedAtRef,
    historyWindow,
    loadOlder,
    prepareThreadSelection,
    prependingRef,
    refresh,
    reset,
    setSummary,
    summary,
  };
}
