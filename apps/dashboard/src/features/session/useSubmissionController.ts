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
import { requestJson } from "../../shared/api/api-client.js";
import { serializeAttachment } from "../composer/attachments.js";
import {
  chatMessageBody,
  normalizeCodexOptionsForUi,
  restoreComposerControlFocus,
} from "../composer/codex-controls.js";
import type { useComposerController } from "../composer/useComposerController.js";
import {
  deviceLabel,
  type SavedCredential,
} from "./session-storage.js";
import {
  setupSubmissionMode,
  type SetupSubmissionMode,
} from "./invite-session.js";

type ComposerController = ReturnType<typeof useComposerController>;

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
  saveCredential: (credential: SavedCredential) => void;
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
  saveCredential,
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
      const result = await requestJson<CreateSessionResponse>("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: roomName,
          ownerDisplayName: displayName,
          deviceLabel: deviceLabel(),
        }),
      });
      setConversationLoading(true);
      saveCredential({
        session: result.session,
        member: result.owner,
        token: result.memberToken,
      });
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
      const result = await requestJson<RecoverSessionResponse>(
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
      saveCredential({
        session: result.session,
        member: result.owner,
        token: result.memberToken,
      });
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
      const result = await requestJson<JoinInviteResponse>("/v1/invites/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inviteToken: joinToken,
          displayName,
          deviceLabel: deviceLabel(),
        }),
      });
      saveCredential({
        session: result.session,
        member: result.member,
        token: result.memberToken,
      });
      setCredentialValidated(true);
      setMembers([result.member]);
      setSetupOpen(false);
      setConnection("waiting");
      setError(null);
      setCredentialNotice(null);
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
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
    const trimmedDraft =
      kind === "chat" ? composer.chatDraft.trim() : composer.draft.trim();
    const body =
      kind === "codex_stop"
        ? "停止当前 Codex 任务"
        : kind === "chat"
          ? chatMessageBody(
              composer.chatDraft,
              composer.pendingChatAttachments.length,
            )
          : trimmedDraft ||
            (kind === "codex_prompt" && composer.pendingAttachments.length > 0
              ? "请处理所附文件。"
              : "");
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
        getCodexModelOption(composer.codexOptions.model)?.label ?? "当前模型";
      if (
        composer.pendingAttachments.some((attachment) =>
          attachment.file.type.startsWith("image/"),
        ) &&
        !codexModelSupportsImages(composer.codexOptions.model)
      ) {
        setError(`${modelLabel} 仅支持文本，请移除图片后再发送`);
        restoreFocus();
        return;
      }
      if (
        !codexModelSupportsReasoningEffort(
          composer.codexOptions.model,
          composer.codexOptions.reasoningEffort,
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
        composer.codexOptions.speed === "fast" &&
        !codexModelSupportsFast(composer.codexOptions.model)
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
          ? await Promise.all(composer.pendingAttachments.map(serializeAttachment))
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
            codexOptions: kind === "codex_prompt" ? composer.codexOptions : null,
          }),
        },
      );
      addMessage(result.message);
      if (kind === "codex_prompt") {
        composer.setDraft("");
        composer.setPendingAttachments([]);
        pushActivity("已加入 Codex 队列", "Host 将在后台直接提交", "info");
      } else if (kind === "codex_stop") {
        pushActivity("停止请求已排队", "Host 将在后台中断当前任务", "warning");
      } else {
        composer.setChatDraft("");
        composer.setPendingChatAttachments([]);
      }
      setError(null);
    } catch (caught) {
      onError(caught);
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
