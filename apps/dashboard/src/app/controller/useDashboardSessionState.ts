import type { Member, Message } from "@codex-collab/protocol";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ActivityItem } from "../../features/activity/ActivityPanel.js";
import { shouldRestoreCredential } from "../../features/session/invite/invite-session.js";
import {
  clearCredential,
  credentialAccessKey,
  credentialHeaders,
  persistCredential,
  type SavedCredential,
  type SessionExitReason,
} from "../../features/session/session-storage.js";
import { isCredentialRejected } from "../../shared/api/api-client.js";
import type { ConnectionState } from "../../features/session/connection.js";
import { mergeConversationMessages } from "../../features/session/message-state.js";

type DashboardSessionStateOptions = {
  initialCredential: SavedCredential | null;
  initialInviteToken: string;
  onSessionCleared: () => void;
};

export function useDashboardSessionState({
  initialCredential,
  initialInviteToken,
  onSessionCleared,
}: DashboardSessionStateOptions) {
  const restoredCredential = useMemo(
    () => (shouldRestoreCredential(initialInviteToken) ? initialCredential : null),
    [initialCredential, initialInviteToken],
  );
  const [credential, setCredential] = useState<SavedCredential | null>(restoredCredential);
  const [credentialValidated, setCredentialValidated] = useState(!restoredCredential);
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([
    {
      id: crypto.randomUUID(),
      title: "Relay 已启动",
      detail: "等待协作会话",
      createdAt: new Date().toISOString(),
      tone: "info",
    },
  ]);
  const [connection, setConnection] = useState<ConnectionState>(
    restoredCredential?.member.status === "pending" ? "waiting" : "ready",
  );
  const [loading, setLoading] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(
    restoredCredential?.member.status === "approved",
  );
  const [error, setError] = useState<string | null>(null);
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(!restoredCredential);
  const composerResetRef = useRef<() => void>(() => undefined);
  const submissionResetRef = useRef<() => void>(() => undefined);
  const workspaceResetRef = useRef<() => void>(() => undefined);
  const workspaceFileResetRef = useRef<() => void>(() => undefined);

  const session = credential?.session ?? null;
  const member = credential?.member ?? null;
  const token = credentialAccessKey(credential);
  const approved = member?.status === "approved";
  const roomOpen = session?.roomStatus !== "closed";
  const composerStorageKey = session ? `codexCollabComposer:${session.id}` : null;

  const pushActivity = useCallback(
    (
      title: string,
      detail: string,
      tone: ActivityItem["tone"] = "info",
    ) => {
      setActivities((current) =>
        [
          {
            id: crypto.randomUUID(),
            title,
            detail,
            tone,
            createdAt: new Date().toISOString(),
          },
          ...current,
        ].slice(0, 8),
      );
    },
    [],
  );

  const clearSessionState = useCallback(
    (reason: SessionExitReason) => {
      void clearCredential().catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "无法清除本机会话凭据");
      });
      setCredential(null);
      setCredentialValidated(true);
      setMembers([]);
      setMessages([]);
      workspaceResetRef.current();
      workspaceFileResetRef.current();
      setConversationLoading(false);
      setLoading(false);
      composerResetRef.current();
      submissionResetRef.current();
      onSessionCleared();
      setError(null);
      setConnection("ready");
      setSetupOpen(true);
      if (reason === "credential-rejected") {
        const detail = "上次保存的会话凭据已失效，请重新创建会话或使用新的邀请加入。";
        setCredentialNotice(detail);
        pushActivity("需要重新连接", detail, "warning");
        return;
      }
      setCredentialNotice(null);
      pushActivity("已离开本机会话", "服务器数据未删除", "info");
    },
    [onSessionCleared, pushActivity],
  );

  const showError = useCallback(
    (caught: unknown) => {
      if (isCredentialRejected(caught)) {
        clearSessionState("credential-rejected");
        return;
      }
      const message = caught instanceof Error ? caught.message : "请求未完成";
      setError(message);
      setConnection("error");
      pushActivity("操作未完成", message, "danger");
    },
    [clearSessionState, pushActivity],
  );

  const saveCredential = useCallback(
    (next: SavedCredential) => {
      setCredential(next);
      void persistCredential(next).catch(showError);
    },
    [showError],
  );
  const authHeaders = useCallback(
    (includeJson = false): HeadersInit => credentialHeaders(credential, includeJson),
    [credential],
  );
  const addMessage = useCallback((next: Message) => {
    setMessages((current) => mergeConversationMessages(current, [next]));
  }, []);

  return {
    activities,
    addMessage,
    approved,
    authHeaders,
    composerResetRef,
    composerStorageKey,
    connection,
    conversationLoading,
    credential,
    credentialNotice,
    credentialValidated,
    error,
    loading,
    member,
    members,
    messages,
    pushActivity,
    resetSession: () => clearSessionState("manual"),
    roomOpen,
    saveCredential,
    session,
    setConnection,
    setConversationLoading,
    setCredentialNotice,
    setCredentialValidated,
    setError,
    setLoading,
    setMembers,
    setMessages,
    setSetupOpen,
    setupOpen,
    showError,
    submissionResetRef,
    token,
    workspaceFileResetRef,
    workspaceResetRef,
  };
}
