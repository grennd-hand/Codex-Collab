import type {
  CreateSessionResponse,
  JoinInviteResponse,
  Member,
  Message,
  MessageKind,
  RecoverSessionResponse,
  Session,
} from "@codex-collab/protocol";
import {
  codexModelSupportsFast,
  codexModelSupportsImages,
  codexModelSupportsReasoningEffort,
  getCodexModelOption,
} from "@codex-collab/protocol";
import { useCallback, useRef, useState } from "react";
import type { ConnectionState } from "../../app/connection.js";
import type { DashboardRuntimeV1 } from "../../shared/runtime/index.js";
import { requestJson } from "../../shared/api/api-client.js";
import { serializeAttachment } from "../composer/attachments.js";
import {
  chatMessageBody,
  normalizeCodexOptionsForUi,
  restoreComposerControlFocus,
} from "../composer/codex-controls.js";
import type { useComposerController } from "../composer/useComposerController.js";
import {
  STALE_WORKSPACE_THREAD_MESSAGE,
  expectedWorkspaceThreadForSubmission,
  isStaleWorkspaceThreadError,
} from "../composer/submission-contract.js";
import {
  clearInviteFromLocation,
  createCredential,
  deviceLabel,
  type SavedCredential,
} from "./session-storage.js";
import {
  setupSubmissionMode,
  type SetupSubmissionMode,
} from "./invite-session.js";

type ComposerController = ReturnType<typeof useComposerController>;

type RuntimeCreateSessionResponse = Omit<CreateSessionResponse, "memberToken"> & {
  memberToken?: string;
};
type RuntimeRecoverSessionResponse = Omit<RecoverSessionResponse, "memberToken"> & {
  memberToken?: string;
};
type RuntimeJoinInviteResponse = Omit<JoinInviteResponse, "memberToken"> & {
  memberToken?: string;
};

type SubmissionControllerOptions = {
  addMessage: (message: Message) => void;
  approved: boolean;
  authHeaders: (includeJson?: boolean) => HeadersInit;
  composer: ComposerController;
  initialInviteToken: string;
  member: Member | null;
  onRecoveryKeyIssued: (sessionId: string, recoveryKey: string) => void;
  onError: (caught: unknown) => void;
  pushActivity: (
    title: string,
    detail: string,
    tone?: "info" | "success" | "warning" | "danger",
  ) => void;
  roomOpen: boolean;
  runtime: DashboardRuntimeV1;
  saveCredential: (credential: SavedCredential) => void;
  selectedThreadId: string | null;
  session: Session | null;
  setConnection: (state: ConnectionState) => void;
  setConversationLoading: (loading: boolean) => void;
  setCredentialNotice: (notice: string | null) => void;
  setCredentialValidated: (validated: boolean) => void;
  setError: (message: string | null) => void;
  setMembers: (members: Member[]) => void;
  setSetupOpen: (open: boolean) => void;
  token: string | null;
};

export function useSubmissionController({
  addMessage,
  approved,
  authHeaders,
  composer,
  initialInviteToken,
  member,
  onRecoveryKeyIssued,
  onError,
  pushActivity,
  roomOpen,
  runtime,
  saveCredential,
  selectedThreadId,
  session,
  setConnection,
  setConversationLoading,
  setCredentialNotice,
  setCredentialValidated,
  setError,
  setMembers,
  setSetupOpen,
  token,
}: SubmissionControllerOptions) {
  const [displayName, setDisplayName] = useState(
    initialInviteToken ? "" : "Owner",
  );
  const [roomName, setRoomName] = useState("Codex shared task");
  const [joinToken, setJoinToken] = useState(initialInviteToken);
  const [setupMode, setSetupMode] = useState<SetupSubmissionMode>(
    initialInviteToken ? "join" : "create",
  );
  const [recoverySessionId, setRecoverySessionId] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const resetRef = useRef(() => setJoinToken(""));

  const createSession = async () => {
    setSubmitting(true);
    try {
      const result = await requestJson<RuntimeCreateSessionResponse>("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: roomName,
          ownerDisplayName: displayName,
          deviceLabel: deviceLabel(),
        }),
      });
      setConversationLoading(true);
      saveCredential(
        createCredential(runtime, result.session, result.owner, result.memberToken),
      );
      setCredentialValidated(true);
      setMembers([result.owner]);
      setSetupOpen(false);
      onRecoveryKeyIssued(result.session.id, result.recoveryKey);
      setConnection("connecting");
      setError(null);
      setCredentialNotice(null);
      pushActivity("共享任务已创建", "你是主人", "success");
    } catch (caught) {
      onError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  const recoverSession = async () => {
    setSubmitting(true);
    try {
      const result = await requestJson<RuntimeRecoverSessionResponse>(
        "/v1/sessions/recover",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: recoverySessionId,
            recoveryKey,
            deviceLabel: deviceLabel(),
          }),
        },
      );
      setConversationLoading(true);
      saveCredential(
        createCredential(runtime, result.session, result.owner, result.memberToken),
      );
      setCredentialValidated(true);
      setMembers([result.owner]);
      setRecoveryKey("");
      setSetupOpen(false);
      setConnection("connecting");
      setError(null);
      setCredentialNotice(null);
      pushActivity("房间已恢复", "已重新取得房主权限", "success");
    } catch (caught) {
      onError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  const joinSession = async () => {
    setSubmitting(true);
    try {
      const result = await requestJson<RuntimeJoinInviteResponse>("/v1/invites/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inviteToken: joinToken,
          displayName,
          deviceLabel: deviceLabel(),
        }),
      });
      saveCredential(
        createCredential(runtime, result.session, result.member, result.memberToken),
      );
      setCredentialValidated(true);
      setMembers([result.member]);
      setSetupOpen(false);
      setConnection("waiting");
      setError(null);
      setCredentialNotice(null);
      clearInviteFromLocation();
      pushActivity("加入申请已发送", "等待主人批准", "warning");
    } catch (caught) {
      onError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  const submitSetup = (event: React.FormEvent) => {
    event.preventDefault();
    const mode = setupSubmissionMode(initialInviteToken, setupMode);
    void (mode === "join"
      ? joinSession()
      : mode === "recover"
        ? recoverSession()
        : createSession());
  };

  const sendMessage = async (kind: MessageKind) => {
    const restoreFocus = () => {
      const control =
        kind === "chat"
          ? composer.chatInputRef.current
          : composer.codexTextareaRef.current;
      restoreComposerControlFocus(control);
    };
    const codexDraft = composer.draft;
    const codexOptions = composer.codexOptions;
    const codexAttachments = composer.pendingAttachments;
    const expectedWorkspaceThreadId = expectedWorkspaceThreadForSubmission(
      kind,
      selectedThreadId,
    );
    const trimmedDraft =
      kind === "chat" ? composer.chatDraft.trim() : codexDraft.trim();
    const body =
      kind === "codex_stop"
        ? "停止当前 Codex 任务"
        : kind === "chat"
          ? chatMessageBody(
              composer.chatDraft,
              composer.pendingChatAttachments.length,
            )
          : trimmedDraft ||
            (kind === "codex_prompt" && codexAttachments.length > 0
              ? "请处理所附文件。"
              : "");
    if (kind === "codex_prompt" && !expectedWorkspaceThreadId) {
      setError("请先选择一个 Codex 任务，再发送指令");
      restoreFocus();
      return;
    }
    if (
      !session ||
      !token ||
      !body ||
      !approved ||
      (kind === "chat" && composer.preparingChatAttachments) ||
      (kind === "codex_prompt" && composer.preparingCodexAttachments) ||
      (!roomOpen && kind !== "codex_stop") ||
      kind === "system"
    ) {
      return;
    }
    if (kind === "codex_prompt") {
      const modelLabel =
        getCodexModelOption(codexOptions.model)?.label ?? "当前模型";
      if (
        codexAttachments.some((attachment) =>
          attachment.file.type.startsWith("image/"),
        ) &&
        !codexModelSupportsImages(codexOptions.model)
      ) {
        setError(`${modelLabel} 仅支持文本，请移除图片后再发送`);
        restoreFocus();
        return;
      }
      if (
        !codexModelSupportsReasoningEffort(
          codexOptions.model,
          codexOptions.reasoningEffort,
        )
      ) {
        composer.setCodexOptions((current) =>
          normalizeCodexOptionsForUi(current),
        );
        setError(`${modelLabel} 不支持当前推理强度，已自动调整`);
        restoreFocus();
        return;
      }
      if (
        codexOptions.speed === "fast" &&
        !codexModelSupportsFast(codexOptions.model)
      ) {
        composer.setCodexOptions((current) =>
          normalizeCodexOptionsForUi(current),
        );
        setError(`${modelLabel} 不支持快速模式，已切换为标准速度`);
        restoreFocus();
        return;
      }
    }
    setSubmitting(true);
    try {
      const attachments =
        kind === "codex_prompt"
          ? await Promise.all(codexAttachments.map(serializeAttachment))
          : kind === "chat"
            ? await Promise.all(
                composer.pendingChatAttachments.map(serializeAttachment),
              )
            : [];
      const result = await requestJson<{ message: Message }>(
        `/v1/sessions/${session.id}/messages`,
        {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            kind,
            body,
            attachments,
            codexOptions: kind === "codex_prompt" ? codexOptions : null,
            ...(expectedWorkspaceThreadId
              ? { expectedWorkspaceThreadId }
              : {}),
          }),
        },
      );
      addMessage(result.message);
      if (kind === "codex_prompt" && expectedWorkspaceThreadId) {
        composer.completeCodexSubmission(
          expectedWorkspaceThreadId,
          codexDraft,
          codexAttachments.map((attachment) => attachment.id),
        );
        pushActivity("已加入 Codex 队列", "Host 将在后台直接提交", "info");
      } else if (kind === "codex_stop") {
        pushActivity("停止请求已排队", "Host 将在后台中断当前任务", "warning");
      } else {
        composer.setChatDraft("");
        composer.setPendingChatAttachments([]);
      }
      setError(null);
    } catch (caught) {
      if (isStaleWorkspaceThreadError(caught)) {
        setError(STALE_WORKSPACE_THREAD_MESSAGE);
        pushActivity(
          "Codex 指令未发送",
          STALE_WORKSPACE_THREAD_MESSAGE,
          "warning",
        );
      } else {
        onError(caught);
      }
    } finally {
      setSubmitting(false);
      restoreFocus();
    }
  };

  const reset = useCallback(() => {
    resetRef.current();
  }, []);

  return {
    displayName,
    joinToken,
    recoveryKey,
    recoverySessionId,
    reset,
    roomName,
    sendMessage,
    setDisplayName,
    setJoinToken,
    setRecoveryKey,
    setRecoverySessionId,
    setRoomName,
    setSetupMode,
    setupMode,
    submitSetup,
    submitting,
  };
}
