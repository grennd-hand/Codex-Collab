import type { ComponentType } from "react";
import type { DashboardViewModel } from "./dashboard-view-model.js";
import { connectionPresentation } from "../features/session/connection.js";
import { useCollaborationController } from "../features/collaboration/useCollaborationController.js";
import { useComposerController } from "../features/composer/useComposerController.js";
import { useInviteController } from "../features/session/invite/useInviteController.js";
import { useOwnerRecoveryController } from "../features/session/recovery/useOwnerRecoveryController.js";
import { useSessionSynchronization } from "../features/session/useSessionSynchronization.js";
import { useSubmissionController } from "../features/session/submission/useSubmissionController.js";
import type { SavedCredential } from "../features/session/session-storage.js";
import { useWorkspaceConnectionController } from "../features/workspace/useWorkspaceConnectionController.js";
import { useWorkspaceFileController } from "../features/workspace/useWorkspaceFileController.js";
import { useWorkspaceHistoryController } from "../features/workspace/useWorkspaceHistoryController.js";
import type { DashboardRuntimeV1 } from "../shared/runtime/index.js";
import { useHostStatus } from "../shared/runtime/use-host-status.js";
import { useDashboardPresentation } from "./controller/useDashboardPresentation.js";
import { useDashboardSessionState } from "./controller/useDashboardSessionState.js";
import {
  useDashboardUiLifecycle,
  useDashboardUiState,
} from "./controller/useDashboardUiState.js";

export interface DashboardControllerProps {
  runtime: DashboardRuntimeV1;
  initialCredential: SavedCredential | null;
  initialInviteToken: string;
  view: ComponentType<{ model: DashboardViewModel }>;
}

export function DashboardController({
  runtime,
  initialCredential,
  initialInviteToken,
  view: View,
}: DashboardControllerProps) {
  const hostStatus = useHostStatus(runtime);
  const ui = useDashboardUiState();
  const state = useDashboardSessionState({
    initialCredential,
    initialInviteToken,
    onSessionCleared: ui.resetMessageStream,
  });

  const workspaceHistory = useWorkspaceHistoryController({
    approved: state.approved,
    authHeaders: state.authHeaders,
    messageStreamRef: ui.messageStreamRef,
    onError: state.showError,
    session: state.session,
    setConversationLoading: state.setConversationLoading,
    token: state.token,
  });
  const workspaceSummary = workspaceHistory.summary;
  const workspaceHistoryWindow = workspaceHistory.historyWindow;
  const selectedThreadId = workspaceSummary?.selectedThreadId ?? null;
  state.workspaceResetRef.current = workspaceHistory.reset;

  const composer = useComposerController({
    onActivity: state.pushActivity,
    roomOpen: state.roomOpen,
    selectedThreadId,
    setError: state.setError,
    storageKey: state.composerStorageKey,
  });
  state.composerResetRef.current = composer.reset;

  const workspaceFiles = useWorkspaceFileController({
    authHeaders: state.authHeaders,
    beginPriorityFileRead: workspaceHistory.beginPriorityFileRead,
    endPriorityFileRead: workspaceHistory.endPriorityFileRead,
    messageStreamPinnedRef: ui.messageStreamPinnedRef,
    messageStreamRef: ui.messageStreamRef,
    onActivity: state.pushActivity,
    onError: state.showError,
    refreshWorkspace: workspaceHistory.refresh,
    session: state.session,
    setError: state.setError,
    setMessageStreamPinned: ui.setMessageStreamPinned,
    summary: workspaceSummary,
  });
  state.workspaceFileResetRef.current = workspaceFiles.reset;

  const workspaceConnection = useWorkspaceConnectionController({
    applyThreadSelection: workspaceHistory.applyThreadSelection,
    authHeaders: state.authHeaders,
    member: state.member,
    onError: state.showError,
    prepareThreadSelection: workspaceHistory.prepareThreadSelection,
    pushActivity: state.pushActivity,
    refreshWorkspace: workspaceHistory.refresh,
    session: state.session,
    setConversationLoading: state.setConversationLoading,
    setEditorExpanded: workspaceFiles.setEditorExpanded,
    summary: workspaceSummary,
  });

  const invite = useInviteController({
    authHeaders: state.authHeaders,
    credential: state.credential,
    member: state.member,
    onError: state.showError,
    pushActivity: state.pushActivity,
    roomOpen: state.roomOpen,
    saveCredential: state.saveCredential,
    session: state.session,
    setError: state.setError,
  });
  const ownerRecovery = useOwnerRecoveryController();

  const submission = useSubmissionController({
    addMessage: state.addMessage,
    approved: state.approved,
    authHeaders: state.authHeaders,
    composer,
    initialInviteToken,
    member: state.member,
    onRecoveryKeyIssued: ownerRecovery.present,
    onError: state.showError,
    pushActivity: state.pushActivity,
    roomOpen: state.roomOpen,
    runtime,
    saveCredential: state.saveCredential,
    selectedThreadId,
    session: state.session,
    setConnection: state.setConnection,
    setConversationLoading: state.setConversationLoading,
    setCredentialNotice: state.setCredentialNotice,
    setCredentialValidated: state.setCredentialValidated,
    setError: state.setError,
    setMembers: state.setMembers,
    setSetupOpen: state.setSetupOpen,
    token: state.token,
  });
  state.submissionResetRef.current = submission.reset;

  const sessionSynchronization = useSessionSynchronization({
    addMessage: state.addMessage,
    approved: state.approved,
    authHeaders: state.authHeaders,
    credential: state.credential,
    credentialValidated: state.credentialValidated,
    member: state.member,
    pushActivity: state.pushActivity,
    refreshWorkspace: workspaceHistory.refresh,
    saveCredential: state.saveCredential,
    session: state.session,
    setConnection: state.setConnection,
    setConversationLoading: state.setConversationLoading,
    setCredentialValidated: state.setCredentialValidated,
    setError: state.setError,
    setInviteOpen: invite.setOpen,
    setLoading: state.setLoading,
    setMembers: state.setMembers,
    setMessages: state.setMessages,
    setWorkspaceSummary: workspaceHistory.setSummary,
    showError: state.showError,
    workspaceHistoryRequestedAtRef: workspaceHistory.historyRequestedAtRef,
  });
  const refresh = sessionSynchronization.refresh;

  const collaboration = useCollaborationController({
    authHeaders: state.authHeaders,
    currentMember: state.member,
    onError: state.showError,
    pushActivity: state.pushActivity,
    refresh,
    session: state.session,
    setError: state.setError,
    setMembers: state.setMembers,
  });

  useDashboardUiLifecycle({
    chatStreamRef: ui.chatStreamRef,
    member: state.member,
    members: state.members,
    messageStreamPinnedRef: ui.messageStreamPinnedRef,
    messageStreamRef: ui.messageStreamRef,
    messages: state.messages,
    setMembersExpanded: ui.setMembersExpanded,
    setThemeMode: ui.setThemeMode,
    themeMode: ui.themeMode,
    workspaceHistoryPrependingRef: workspaceHistory.prependingRef,
    workspaceHistoryWindow,
    workspaceSummary,
  });

  const presentation = useDashboardPresentation({
    approved: state.approved,
    composer,
    conversationLoading: state.conversationLoading,
    member: state.member,
    members: state.members,
    messages: state.messages,
    selectedThreadId,
    workspaceHistoryWindow,
    workspaceSummary,
  });
  const viewModel: DashboardViewModel = {
    ...presentation,
    activities: state.activities,
    approved: state.approved,
    chatStreamRef: ui.chatStreamRef,
    collaboration,
    composer,
    connectionStatus: connectionPresentation(state.connection, Boolean(state.session)),
    credentialNotice: state.credentialNotice,
    error: state.error,
    hostStatus,
    initialInviteToken,
    invite,
    loading: state.loading,
    member: state.member,
    members: state.members,
    membersExpanded: ui.membersExpanded,
    messageStreamPinned: ui.messageStreamPinned,
    messageStreamRef: ui.messageStreamRef,
    onMessageStreamPinnedChange: ui.onMessageStreamPinnedChange,
    ownerRecovery,
    refresh,
    resetSession: state.resetSession,
    roomOpen: state.roomOpen,
    session: state.session,
    setCredentialNotice: state.setCredentialNotice,
    setError: state.setError,
    setMembersExpanded: ui.setMembersExpanded,
    setSetupOpen: state.setSetupOpen,
    setThemeMode: ui.setThemeMode,
    setupOpen: state.setupOpen,
    showError: state.showError,
    submission,
    themeMode: ui.themeMode,
    token: state.token,
    workspaceConnection,
    workspaceFiles,
    workspaceHistory,
  };
  return <View model={viewModel} />;
}
