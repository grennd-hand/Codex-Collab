import type {
  CreateHostPairingResponse,
  Member,
  Session,
  WorkspaceSummary,
} from "@codex-collab/protocol";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../../shared/clipboard.js";
import { requestJson } from "../../shared/api/api-client.js";

type WorkspaceConnectionControllerOptions = {
  applyThreadSelection: (
    workspace: WorkspaceSummary,
    sessionId: string,
    threadId: string,
  ) => void;
  authHeaders: (includeJson?: boolean) => HeadersInit;
  clearFileCache: () => void;
  member: Member | null;
  onError: (caught: unknown) => void;
  prepareThreadSelection: () => void;
  pushActivity: (
    title: string,
    detail: string,
    tone?: "info" | "success" | "warning" | "danger",
  ) => void;
  refreshWorkspace: (includeHistory?: boolean) => Promise<WorkspaceSummary | null>;
  session: Session | null;
  setConversationLoading: (loading: boolean) => void;
  setEditorExpanded: (expanded: boolean) => void;
  summary: WorkspaceSummary | null;
};

export function useWorkspaceConnectionController({
  applyThreadSelection,
  authHeaders,
  clearFileCache,
  member,
  onError,
  prepareThreadSelection,
  pushActivity,
  refreshWorkspace,
  session,
  setConversationLoading,
  setEditorExpanded,
  summary,
}: WorkspaceConnectionControllerOptions) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pairingToken, setPairingToken] = useState("");
  const [pairingExpiresAt, setPairingExpiresAt] = useState("");
  const [pairingCopied, setPairingCopied] = useState(false);
  const pairingTokenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (summary?.hostConnected) {
      setOpen(false);
    } else {
      setEditorExpanded(false);
    }
  }, [setEditorExpanded, summary?.hostConnected]);

  const reload = async () => {
    setLoading(true);
    try {
      await refreshWorkspace();
    } catch (caught) {
      onError(caught);
    } finally {
      setLoading(false);
    }
  };

  const openDialog = async () => {
    setOpen(true);
    await reload();
  };

  const createPairing = async () => {
    if (!session || member?.role !== "owner") return;
    setLoading(true);
    try {
      const result = await requestJson<CreateHostPairingResponse>(
        `/v1/sessions/${session.id}/host-pairings`,
        {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({ expiresInMinutes: 10 }),
        },
      );
      setPairingToken(result.pairingToken);
      setPairingExpiresAt(result.expiresAt);
      setPairingCopied(false);
      pushActivity("本机配对码已生成", "10 分钟内使用一次", "success");
    } catch (caught) {
      onError(caught);
    } finally {
      setLoading(false);
    }
  };

  const copyPairing = async () => {
    const copiedSuccessfully = await copyText(
      pairingToken,
      pairingTokenRef.current ?? undefined,
    );
    setPairingCopied(copiedSuccessfully);
    if (!copiedSuccessfully) {
      pairingTokenRef.current?.focus();
      pairingTokenRef.current?.select();
    }
  };

  const selectThread = async (threadId: string) => {
    if (!session || !threadId || member?.role !== "owner") return;
    prepareThreadSelection();
    setLoading(true);
    setConversationLoading(true);
    try {
      const result = await requestJson<{ workspace: WorkspaceSummary }>(
        `/v1/sessions/${session.id}/workspace/selection`,
        {
          method: "PUT",
          headers: authHeaders(true),
          body: JSON.stringify({ threadId }),
        },
      );
      clearFileCache();
      applyThreadSelection(result.workspace, session.id, threadId);
      pushActivity("已选择 Codex 任务", "等待本机插件导入记录与文件", "success");
      void refreshWorkspace(true).catch(onError);
    } catch (caught) {
      setConversationLoading(false);
      onError(caught);
    } finally {
      setLoading(false);
    }
  };

  return {
    copyPairing,
    createPairing,
    loading,
    open,
    openDialog,
    pairingCopied,
    pairingExpiresAt,
    pairingToken,
    pairingTokenRef,
    reload,
    selectThread,
    setOpen,
  };
}
