import type { Member, Message, WorkspaceSummary } from "@codex-collab/protocol";
import { useMemo } from "react";
import { buildMemberIdentityMap, fallbackMemberIdentity } from "../../features/collaboration/member-identity.js";
import { canMemberStopCodex, codexExecutionPhase, composerPrimaryAction } from "../../features/composer/codex-controls.js";
import type { useComposerController } from "../../features/composer/useComposerController.js";
import { collectExecutionFileChanges } from "../../features/timeline/content/readable-output.js";
import {
  buildUnifiedTimeline,
  selectCodexMessagesForThread,
  splitConversationMessages,
} from "../../features/timeline/history/imported-timeline.js";
import {
  workspaceHistoryEntries,
  type WorkspaceHistoryWindow,
} from "../../features/workspace/history/workspace-history-window.js";
import { memberWorkspaceFileAccess } from "../../features/workspace/member-file-access.js";

type DashboardPresentationOptions = {
  approved: boolean;
  composer: ReturnType<typeof useComposerController>;
  conversationLoading: boolean;
  member: Member | null;
  members: Member[];
  messages: Message[];
  selectedThreadId: string | null;
  workspaceHistoryWindow: WorkspaceHistoryWindow;
  workspaceSummary: WorkspaceSummary | null;
};

export function useDashboardPresentation({
  approved,
  composer,
  conversationLoading,
  member,
  members,
  messages,
  selectedThreadId,
  workspaceHistoryWindow,
  workspaceSummary,
}: DashboardPresentationOptions) {
  const importedHistory = useMemo(
    () => workspaceHistoryEntries(workspaceHistoryWindow),
    [workspaceHistoryWindow],
  );
  const workspaceFileChanges = useMemo(
    () => collectExecutionFileChanges(importedHistory),
    [importedHistory],
  );
  const memberIdentities = useMemo(() => buildMemberIdentityMap(members), [members]);
  const { chatMessages, codexMessages } = splitConversationMessages(messages);
  const { currentThreadMessages, unassignedMessages } =
    selectCodexMessagesForThread(codexMessages, selectedThreadId);
  const codexTimeline = buildUnifiedTimeline(
    workspaceHistoryWindow.items,
    currentThreadMessages,
    { historyHasOlder: workspaceHistoryWindow.hasOlder },
  );
  const executionPhase = codexExecutionPhase(
    currentThreadMessages,
    workspaceSummary?.codexRuntimeStatus,
  );
  const latestCodexTimelineItem = codexTimeline.at(-1);
  const workspaceFileAccess = memberWorkspaceFileAccess(member);

  return {
    canSendChat: Boolean(
      !composer.preparingChatAttachments &&
        (composer.chatDraft.trim() || composer.pendingChatAttachments.length > 0),
    ),
    canSendCodex: Boolean(
      selectedThreadId &&
        !composer.preparingCodexAttachments &&
        (composer.draft.trim() || composer.pendingAttachments.length > 0),
    ),
    canStopCodex: canMemberStopCodex(member, executionPhase),
    chatMessages,
    codexTimeline,
    conversationInitialLoading:
      conversationLoading ||
      (workspaceHistoryWindow.initialLoading && workspaceHistoryWindow.items.length === 0),
    executionEntryCount: importedHistory.filter(
      (entry) => entry.role === "reasoning" || entry.role === "command",
    ).length,
    executionPhase,
    hasCodexContent: importedHistory.length > 0 || currentThreadMessages.length > 0,
    hasRunningExecutionEntry:
      executionPhase === "running" &&
      latestCodexTimelineItem?.kind === "imported" &&
      latestCodexTimelineItem.item.kind === "execution",
    hiddenUnassignedMessageCount: selectedThreadId ? unassignedMessages.length : 0,
    identityForMember: (memberId: string) =>
      memberIdentities.get(memberId) ?? fallbackMemberIdentity(memberId),
    owner: members.find((item) => item.role === "owner"),
    pendingMemberCount: members.filter((item) => item.status === "pending").length,
    primaryStopsCodex: composerPrimaryAction(executionPhase, "codex") === "stop_codex",
    workspaceConnected: Boolean(approved && workspaceSummary?.hostConnected),
    workspaceFileChanges,
    workspaceReadOnly: workspaceFileAccess !== "workspace-write",
  };
}
