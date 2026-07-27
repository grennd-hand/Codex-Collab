import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Member,
  Message,
  Session,
} from "@codex-collab/protocol";
import { DashboardView } from "./app/DashboardView.js";
import type { DashboardViewModel } from "./app/dashboard-view-model.js";
import {
  buildUnifiedTimeline,
  selectCodexMessagesForThread,
  splitConversationMessages,
} from "./features/timeline/imported-timeline.js";
import { shouldRestoreCredential } from "./features/session/invite-session.js";
import {
  buildMemberIdentityMap,
  fallbackMemberIdentity,
} from "./features/collaboration/member-identity.js";
import { useCollaborationController } from "./features/collaboration/useCollaborationController.js";
import {
  isCredentialRejected,
  requestJson,
} from "./shared/api/api-client.js";
import { useComposerController } from "./features/composer/useComposerController.js";
import {
  connectionPresentation,
  type ConnectionState,
} from "./app/connection.js";
import { collectExecutionFileChanges } from "./features/timeline/readable-output.js";
import {
  canMemberStopCodex,
  codexExecutionPhase,
  composerPrimaryAction,
} from "./features/composer/codex-controls.js";
import {
  workspaceHistoryEntries,
} from "./app/workspace-history-window.js";
import { useSessionSynchronization } from "./features/session/useSessionSynchronization.js";
import { type ThemeMode } from "./app/shell/theme.js";
import {
  clearCredential,
  inviteTokenFromLocation,
  loadCredential,
  persistCredential,
  type SavedCredential,
  type SessionExitReason,
} from "./features/session/session-storage.js";
import { useInviteController } from "./features/session/useInviteController.js";
import { useOwnerRecoveryController } from "./features/session/useOwnerRecoveryController.js";
import { useSubmissionController } from "./features/session/useSubmissionController.js";
import { useWorkspaceConnectionController } from "./features/workspace/useWorkspaceConnectionController.js";
import {
  useWorkspaceFileController,
} from "./features/workspace/useWorkspaceFileController.js";
import {
  useWorkspaceHistoryController,
} from "./features/workspace/useWorkspaceHistoryController.js";
import {
  memberWorkspaceFileAccess,
} from "./features/workspace/member-file-access.js";
import { type ActivityItem } from "./features/activity/ActivityPanel.js";

export function App() {
  const initialInviteToken = useMemo(inviteTokenFromLocation, []);
  const initialCredential = useMemo(
    () => (shouldRestoreCredential(initialInviteToken) ? loadCredential() : null),
    [initialInviteToken],
  );
  const [credential, setCredential] = useState<SavedCredential | null>(initialCredential);
  const [credentialValidated, setCredentialValidated] = useState(!initialCredential);
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
    initialCredential?.member.status === "pending" ? "waiting" : "ready",
  );
  const [loading, setLoading] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(
    initialCredential?.member.status === "approved",
  );
  const [error, setError] = useState<string | null>(null);
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(!initialCredential);
  const [membersExpanded, setMembersExpanded] = useState(true);
  const [messageStreamPinned, setMessageStreamPinned] = useState(true);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const messageStreamRef = useRef<HTMLElement>(null);
  const messageStreamPinnedRef = useRef(true);
  const chatStreamRef = useRef<HTMLDivElement>(null);
  const composerResetRef = useRef<() => void>(() => undefined);
  const submissionResetRef = useRef<() => void>(() => undefined);
  const workspaceResetRef = useRef<() => void>(() => undefined);
  const workspaceFileResetRef = useRef<() => void>(() => undefined);
  const sessionErrorHandlerRef = useRef<(caught: unknown) => void>(() => undefined);

  const session = credential?.session ?? null;
  const member = credential?.member ?? null;
  const token = credential?.token ?? null;
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
      clearCredential();
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
      setMessageStreamPinned(true);
      messageStreamPinnedRef.current = true;
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
    [pushActivity],
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
  sessionErrorHandlerRef.current = showError;

  const composer = useComposerController({
    onActivity: pushActivity,
    roomOpen,
    setError,
    storageKey: composerStorageKey,
  });
  const {
    chatDraft,
    draft,
    pendingAttachments,
    pendingChatAttachments,
    preparingChatAttachments,
    preparingCodexAttachments,
  } = composer;
  composerResetRef.current = composer.reset;

  const saveCredential = useCallback((next: SavedCredential) => {
    setCredential(next);
    persistCredential(next);
  }, []);

  const authHeaders = useCallback(
    (includeJson = false): HeadersInit => ({
      authorization: `Bearer ${token ?? ""}`,
      ...(includeJson ? { "content-type": "application/json" } : {}),
    }),
    [token],
  );

  const workspaceHistory = useWorkspaceHistoryController({
    approved,
    authHeaders,
    messageStreamRef,
    onError: showError,
    session,
    setConversationLoading,
    token,
  });
  const workspaceSummary = workspaceHistory.summary;
  const setWorkspaceSummary = workspaceHistory.setSummary;
  const workspaceHistoryWindow = workspaceHistory.historyWindow;
  const refreshWorkspace = workspaceHistory.refresh;
  const workspaceHistoryRequestedAtRef = workspaceHistory.historyRequestedAtRef;
  const workspaceHistoryPrependingRef = workspaceHistory.prependingRef;
  workspaceResetRef.current = workspaceHistory.reset;

  const workspaceFiles = useWorkspaceFileController({
    authHeaders,
    beginPriorityFileRead: workspaceHistory.beginPriorityFileRead,
    endPriorityFileRead: workspaceHistory.endPriorityFileRead,
    messageStreamPinnedRef,
    messageStreamRef,
    onActivity: pushActivity,
    onError: showError,
    refreshWorkspace,
    session,
    setError,
    setMessageStreamPinned,
    summary: workspaceSummary,
  });
  const setWorkspaceEditorExpanded = workspaceFiles.setEditorExpanded;
  workspaceFileResetRef.current = workspaceFiles.reset;

  const workspaceConnection = useWorkspaceConnectionController({
    applyThreadSelection: workspaceHistory.applyThreadSelection,
    authHeaders,
    clearFileCache: workspaceFiles.clearCache,
    member,
    onError: showError,
    prepareThreadSelection: workspaceHistory.prepareThreadSelection,
    pushActivity,
    refreshWorkspace,
    session,
    setConversationLoading,
    setEditorExpanded: setWorkspaceEditorExpanded,
    summary: workspaceSummary,
  });

  const invite = useInviteController({
    authHeaders,
    member,
    onError: showError,
    pushActivity,
    roomOpen,
    saveCredential,
    session,
    setError,
    token,
  });
  const ownerRecovery = useOwnerRecoveryController();
  const setInviteOpen = invite.setOpen;

  const addMessage = useCallback((next: Message) => {
    setMessages((current) => {
      const index = current.findIndex((message) => message.id === next.id);
      if (index === -1) return [...current, next];
      const updated = [...current];
      updated[index] = next;
      return updated;
    });
  }, []);

  const submission = useSubmissionController({
    addMessage,
    approved,
    authHeaders,
    composer,
    initialInviteToken,
    member,
    onRecoveryKeyIssued: ownerRecovery.present,
    onError: showError,
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
  });
  submissionResetRef.current = submission.reset;

  const sessionSynchronization = useSessionSynchronization({
    addMessage,
    approved,
    authHeaders,
    credentialValidated,
    member,
    pushActivity,
    refreshWorkspace,
    saveCredential,
    session,
    setConnection,
    setConversationLoading,
    setCredentialValidated,
    setError,
    setInviteOpen,
    setLoading,
    setMembers,
    setMessages,
    setWorkspaceSummary,
    showError,
    token,
    workspaceHistoryRequestedAtRef,
  });
  const refresh = sessionSynchronization.refresh;

  const collaboration = useCollaborationController({
    authHeaders,
    currentMember: member,
    onError: showError,
    pushActivity,
    refresh,
    session,
    setError,
    setMembers,
  });
  const approveMember = collaboration.approveMember;
  const updateMemberWorkspaceFileAccess = collaboration.updateWorkspaceFileAccess;
  const workspaceAccessUpdatingMemberId =
    collaboration.workspaceAccessUpdatingMemberId;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      setThemeMode(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    const stream = messageStreamRef.current;
    if (
      stream &&
      messageStreamPinnedRef.current &&
      !workspaceHistoryPrependingRef.current
    ) {
      stream.scrollTop = stream.scrollHeight;
    }
    const chatStream = chatStreamRef.current;
    if (chatStream) {
      chatStream.scrollTop = chatStream.scrollHeight;
    }
  }, [
    messages,
    workspaceSummary?.codexRuntimeStatus,
    workspaceHistoryWindow.items.length,
    workspaceHistoryWindow.items.at(-1)?.entry.text,
  ]);

  useEffect(() => {
    if (
      member?.role === "owner" &&
      members.some((current) => current.status === "pending")
    ) {
      setMembersExpanded(true);
    }
  }, [member?.role, members]);

  const resetSession = () => {
    clearSessionState("manual");
  };

  const owner = members.find((item) => item.role === "owner");
  const status = connectionPresentation(connection, Boolean(session));
  const importedHistory = useMemo(
    () => workspaceHistoryEntries(workspaceHistoryWindow),
    [workspaceHistoryWindow],
  );
  const workspaceFileChanges = useMemo(
    () => collectExecutionFileChanges(importedHistory),
    [importedHistory],
  );
  const { chatMessages, codexMessages } = splitConversationMessages(messages);
  const { currentThreadMessages, unassignedMessages } =
    selectCodexMessagesForThread(
      codexMessages,
      workspaceSummary?.selectedThreadId,
    );
  const codexTimeline = buildUnifiedTimeline(
    workspaceHistoryWindow.items,
    currentThreadMessages,
  );
  const hasCodexContent =
    importedHistory.length > 0 || currentThreadMessages.length > 0;
  const conversationInitialLoading =
    conversationLoading ||
    (workspaceHistoryWindow.initialLoading && workspaceHistoryWindow.items.length === 0);
  const hiddenUnassignedMessageCount = workspaceSummary?.selectedThreadId
    ? unassignedMessages.length
    : 0;
  const pendingMemberCount = members.filter((item) => item.status === "pending").length;
  const workspaceFileAccess = memberWorkspaceFileAccess(member);
  const workspaceReadOnly = workspaceFileAccess !== "workspace-write";
  const workspaceConnected = Boolean(approved && workspaceSummary?.hostConnected);
  const memberIdentities = useMemo(() => buildMemberIdentityMap(members), [members]);
  const identityForMember = (memberId: string) =>
    memberIdentities.get(memberId) ?? fallbackMemberIdentity(memberId);
  const executionPhase = codexExecutionPhase(
    currentThreadMessages,
    workspaceSummary?.codexRuntimeStatus,
  );
  const executionEntryCount = importedHistory.filter(
    (entry) => entry.role === "reasoning" || entry.role === "command",
  ).length;
  const latestCodexTimelineItem = codexTimeline.at(-1);
  const hasRunningExecutionEntry =
    executionPhase === "running" &&
    latestCodexTimelineItem?.kind === "imported" &&
    latestCodexTimelineItem.item.kind === "execution";
  const canStopCodex = canMemberStopCodex(member, executionPhase);
  const primaryComposerAction = composerPrimaryAction(executionPhase, "codex");
  const primaryStopsCodex = primaryComposerAction === "stop_codex";
  const canSendChat = Boolean(
    !preparingChatAttachments && (chatDraft.trim() || pendingChatAttachments.length > 0),
  );
  const canSendCodex = Boolean(
    !preparingCodexAttachments && (draft.trim() || pendingAttachments.length > 0),
  );
  const viewModel: DashboardViewModel = {
    activities,
    approved,
    canSendChat,
    canSendCodex,
    canStopCodex,
    chatMessages,
    chatStreamRef,
    codexTimeline,
    collaboration,
    composer,
    connectionStatus: status,
    conversationInitialLoading,
    credentialNotice,
    error,
    executionEntryCount,
    executionPhase,
    hasCodexContent,
    hasRunningExecutionEntry,
    hiddenUnassignedMessageCount,
    identityForMember,
    initialInviteToken,
    invite,
    loading,
    member,
    members,
    membersExpanded,
    messageStreamPinned,
    messageStreamRef,
    onMessageStreamPinnedChange: (pinned) => {
      messageStreamPinnedRef.current = pinned;
      setMessageStreamPinned(pinned);
    },
    owner,
    ownerRecovery,
    pendingMemberCount,
    primaryStopsCodex,
    refresh,
    resetSession,
    roomOpen,
    session,
    setCredentialNotice,
    setError,
    setMembersExpanded,
    setSetupOpen,
    setThemeMode,
    setupOpen,
    showError,
    submission,
    themeMode,
    token,
    workspaceConnected,
    workspaceConnection,
    workspaceFileChanges,
    workspaceFiles,
    workspaceHistory,
    workspaceReadOnly,
  };
  return <DashboardView model={viewModel} />;
}
