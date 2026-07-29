import type { DashboardViewModel } from "../../../dashboard/src/app/dashboard-view-model.js";
import { CollaborationPanel } from "../../../dashboard/src/features/collaboration/CollaborationPanel.js";

export function DesktopCollaborationPane({
  model,
}: {
  model: DashboardViewModel;
}) {
  const { collaboration, composer, submission } = model;
  return (
    <CollaborationPanel
      membersExpanded={model.membersExpanded}
      pendingMemberCount={model.pendingMemberCount}
      members={model.members}
      loading={model.loading}
      currentMember={model.member}
      owner={model.owner}
      workspaceAccessUpdatingMemberId={
        collaboration.workspaceAccessUpdatingMemberId
      }
      identityForMember={model.identityForMember}
      onToggleMembers={() =>
        model.setMembersExpanded((current) => !current)
      }
      onApproveMember={(target) => void collaboration.approveMember(target)}
      onUpdateWorkspaceFileAccess={(target, access) =>
        void collaboration.updateWorkspaceFileAccess(target, access)
      }
      chatMessages={model.chatMessages}
      chatStreamRef={model.chatStreamRef}
      approved={model.approved}
      sessionId={model.session?.id ?? null}
      token={model.token}
      onAttachmentError={composer.showAttachmentError}
      draggingChatFiles={composer.draggingChatFiles}
      onDraggingChatFilesChange={composer.setDraggingChatFiles}
      submitting={submission.submitting}
      preparingChatAttachments={composer.preparingChatAttachments}
      chatAttachmentInputRef={composer.chatAttachmentInputRef}
      pendingChatAttachments={composer.pendingChatAttachments}
      onRemoveChatAttachment={(attachmentId) =>
        composer.setPendingChatAttachments((current) =>
          current.filter((item) => item.id !== attachmentId),
        )
      }
      onAddChatAttachments={(files) => void composer.addChatAttachments(files)}
      chatInputRef={composer.chatInputRef}
      chatDraft={composer.chatDraft}
      onChatDraftChange={composer.setChatDraft}
      roomOpen={model.roomOpen}
      canSendChat={model.canSendChat}
      onSendChat={() => void submission.sendMessage("chat")}
    />
  );
}
