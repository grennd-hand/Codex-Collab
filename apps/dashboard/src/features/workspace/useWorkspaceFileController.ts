import type { Session, WorkspaceSummary } from "@codex-collab/protocol";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { resolveWorkspaceFilePath } from "../../ide/file-tree.js";
import {
  WorkspaceFileCache,
  workspaceFileCacheKey,
} from "../../ide/workspace-file-cache.js";
import {
  readWorkspaceFileOperation,
  saveWorkspaceFileOperation,
} from "../../ide/workspace-file-operations.js";
import type {
  IdeFileDocument,
  IdeNavigationTarget,
  IdeOpenFileRequest,
  IdeSaveRequest,
  IdeSaveResult,
} from "../../ide/types.js";
import {
  captureHistoryScrollAnchor,
  restoreHistoryScrollAnchor,
  type HistoryScrollAnchor,
} from "../timeline/history-scroll.js";

type WorkspaceFileControllerOptions = {
  authHeaders: (includeJson?: boolean) => HeadersInit;
  beginPriorityFileRead: () => void;
  endPriorityFileRead: () => void;
  messageStreamPinnedRef: RefObject<boolean>;
  messageStreamRef: RefObject<HTMLElement | null>;
  onActivity: (
    title: string,
    detail: string,
    tone?: "info" | "success" | "warning" | "danger",
  ) => void;
  onError: (caught: unknown) => void;
  refreshWorkspace: (includeHistory?: boolean) => Promise<WorkspaceSummary | null>;
  session: Session | null;
  setError: (error: string | null) => void;
  setMessageStreamPinned: (pinned: boolean) => void;
  summary: WorkspaceSummary | null;
};

export function useWorkspaceFileController({
  authHeaders,
  beginPriorityFileRead,
  endPriorityFileRead,
  messageStreamPinnedRef,
  messageStreamRef,
  onActivity,
  onError,
  refreshWorkspace,
  session,
  setError,
  setMessageStreamPinned,
  summary,
}: WorkspaceFileControllerOptions) {
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [openFileRequest, setOpenFileRequest] = useState<IdeOpenFileRequest | null>(
    null,
  );
  const openFileSequenceRef = useRef(0);
  const navigationScrollAnchorRef = useRef<HistoryScrollAnchor | null>(null);
  const cacheRef = useRef(new WorkspaceFileCache());
  const readsRef = useRef(new Map<string, Promise<IdeFileDocument>>());

  const clearCache = useCallback(() => {
    cacheRef.current.clear();
    readsRef.current.clear();
  }, []);

  const reset = useCallback(() => {
    clearCache();
    setOpenFileRequest(null);
    setEditorExpanded(false);
  }, [clearCache]);

  useEffect(() => reset(), [reset, session?.id]);

  useLayoutEffect(() => {
    const anchor = navigationScrollAnchorRef.current;
    if (!anchor) return;
    navigationScrollAnchorRef.current = null;
    restoreHistoryScrollAnchor(messageStreamRef.current, anchor);
  }, [editorExpanded, messageStreamRef, openFileRequest]);

  const readFile = useCallback(
    async (path: string): Promise<IdeFileDocument> => {
      if (!session) throw new Error("当前没有可用的协作会话。");
      const metadata = summary?.files.find((file) => file.path === path);
      const key = workspaceFileCacheKey(
        session.id,
        summary?.selectedThreadId ?? null,
        path,
        metadata?.sha256 ?? "latest",
      );
      const cached = cacheRef.current.get(key);
      if (cached) return cached;
      const existingRead = readsRef.current.get(key);
      if (existingRead) return existingRead;

      beginPriorityFileRead();
      const request = readWorkspaceFileOperation(
        { sessionId: session.id, headers: authHeaders(true) },
        path,
      )
        .then((file) => {
          const authoritativeKey = workspaceFileCacheKey(
            session.id,
            summary?.selectedThreadId ?? null,
            path,
            file.sha256,
          );
          cacheRef.current.set(authoritativeKey, file);
          if (authoritativeKey === key) cacheRef.current.set(key, file);
          setError(null);
          return file;
        })
        .finally(() => {
          readsRef.current.delete(key);
          endPriorityFileRead();
        });
      readsRef.current.set(key, request);
      return request;
    },
    [
      authHeaders,
      beginPriorityFileRead,
      endPriorityFileRead,
      session,
      setError,
      summary,
    ],
  );

  const saveFile = useCallback(
    async (request: IdeSaveRequest): Promise<IdeSaveResult> => {
      if (!session) throw new Error("当前没有可用的协作会话。");
      const result = await saveWorkspaceFileOperation(
        { sessionId: session.id, headers: authHeaders(true) },
        request,
      );
      clearCache();
      if (result.status === "saved") {
        onActivity("项目文件已保存", request.path, "success");
        void refreshWorkspace().catch(onError);
      } else {
        onActivity("项目文件存在冲突", request.path, "warning");
      }
      setError(null);
      return result;
    },
    [
      authHeaders,
      clearCache,
      onActivity,
      onError,
      refreshWorkspace,
      session,
      setError,
    ],
  );

  const openFromExecution = useCallback(
    (target: IdeNavigationTarget) => {
      if (!summary) return;
      const path = resolveWorkspaceFilePath(target.path, summary.files);
      if (!path) {
        setError(`无法在当前共享项目中定位文件：${target.path}`);
        return;
      }
      navigationScrollAnchorRef.current = captureHistoryScrollAnchor(
        messageStreamRef.current,
      );
      messageStreamPinnedRef.current = false;
      setMessageStreamPinned(false);
      setEditorExpanded(true);
      openFileSequenceRef.current += 1;
      setOpenFileRequest({
        ...target,
        path,
        requestId: openFileSequenceRef.current,
      });
    },
    [
      messageStreamPinnedRef,
      messageStreamRef,
      setError,
      setMessageStreamPinned,
      summary,
    ],
  );

  return {
    clearCache,
    editorExpanded,
    openFileRequest,
    openFromExecution,
    readFile,
    reset,
    saveFile,
    setEditorExpanded,
  };
}
