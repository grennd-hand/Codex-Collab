import {
  Avatar,
  Badge,
  Button,
  Input,
  Spinner,
} from "@fluentui/react-components";
import {
  AttachRegular,
  ChatRegular,
  DeleteRegular,
  SendRegular,
} from "@fluentui/react-icons";
import type { Member, Message } from "@codex-collab/protocol";
import type { RefObject } from "react";
import {
  PeerChatAttachment,
  attachmentSizeLabel,
  type PendingAttachment,
} from "../composer/attachments.js";
import { shortTimeLabel } from "../../shared/date-time.js";
import type { WorkspaceFileAccess } from "../workspace/member-file-access.js";
import type { MemberIdentity } from "./member-identity.js";
import { MembersPanel } from "./MembersPanel.js";

export interface CollaborationPanelProps {
  membersExpanded: boolean;
  pendingMemberCount: number;
  members: Member[];
  loading: boolean;
  currentMember: Member | null;
  owner: Member | undefined;
  workspaceAccessUpdatingMemberId: string | null;
  identityForMember: (memberId: string) => MemberIdentity;
  onToggleMembers: () => void;
  onApproveMember: (member: Member) => void;
  onUpdateWorkspaceFileAccess: (
    member: Member,
    access: WorkspaceFileAccess,
  ) => void;
  chatMessages: Message[];
  chatStreamRef: RefObject<HTMLDivElement | null>;
  approved: boolean;
  sessionId: string | null;
  token: string | null;
  onAttachmentError: (error: unknown) => void;
  draggingChatFiles: boolean;
  onDraggingChatFilesChange: (dragging: boolean) => void;
  submitting: boolean;
  preparingChatAttachments: boolean;
  chatAttachmentInputRef: RefObject<HTMLInputElement | null>;
  pendingChatAttachments: PendingAttachment[];
  onRemoveChatAttachment: (attachmentId: string) => void;
  onAddChatAttachments: (files: FileList | File[]) => void;
  chatInputRef: RefObject<HTMLInputElement | null>;
  chatDraft: string;
  onChatDraftChange: (draft: string) => void;
  roomOpen: boolean;
  canSendChat: boolean;
  onSendChat: () => void;
}

export function CollaborationPanel({
  membersExpanded,
  pendingMemberCount,
  members,
  loading,
  currentMember,
  owner,
  workspaceAccessUpdatingMemberId,
  identityForMember,
  onToggleMembers,
  onApproveMember,
  onUpdateWorkspaceFileAccess,
  chatMessages,
  chatStreamRef,
  approved,
  sessionId,
  token,
  onAttachmentError,
  draggingChatFiles,
  onDraggingChatFilesChange,
  submitting,
  preparingChatAttachments,
  chatAttachmentInputRef,
  pendingChatAttachments,
  onRemoveChatAttachment,
  onAddChatAttachments,
  chatInputRef,
  chatDraft,
  onChatDraftChange,
  roomOpen,
  canSendChat,
  onSendChat,
}: CollaborationPanelProps) {
  return (
    <aside
      className="people-panel"
      aria-label="协作成员"
      data-workspace-panel="people"
    >
      <MembersPanel
        expanded={membersExpanded}
        pendingCount={pendingMemberCount}
        members={members}
        loading={loading}
        currentMember={currentMember}
        owner={owner}
        workspaceAccessUpdatingMemberId={workspaceAccessUpdatingMemberId}
        identityForMember={identityForMember}
        onToggle={onToggleMembers}
        onApproveMember={onApproveMember}
        onUpdateWorkspaceFileAccess={onUpdateWorkspaceFileAccess}
      />

      <section className="peer-chat-panel" aria-labelledby="peer-chat-title">
        <div className="peer-chat-heading">
          <div>
            <h2 id="peer-chat-title">协作聊天</h2>
            <p>独立于 Codex 任务</p>
          </div>
          <Badge appearance="tint">{chatMessages.length}</Badge>
        </div>
        <div
          className="peer-chat-stream"
          ref={chatStreamRef}
          aria-label="成员聊天消息"
          aria-live="polite"
        >
          {chatMessages.length === 0 ? (
            <div className="peer-chat-empty">
              <ChatRegular aria-hidden="true" />
              <p>{approved ? "在这里和协作者单独沟通" : "批准后可查看协作聊天"}</p>
            </div>
          ) : (
            chatMessages.map((item) => {
              const mine = item.senderMemberId === currentMember?.id;
              const identity = identityForMember(item.senderMemberId);
              return (
                <article
                  className={`peer-chat-message ${mine ? "mine" : ""}`}
                  style={identity.style}
                  key={item.id}
                >
                  <div className="peer-chat-meta">
                    <Avatar
                      name={item.senderDisplayName}
                      color={identity.avatarColor}
                      size={20}
                    />
                    <strong>{item.senderDisplayName}</strong>
                    <time dateTime={item.createdAt}>
                      {shortTimeLabel(item.createdAt)}
                    </time>
                  </div>
                  <div className="peer-chat-bubble">
                    <p>{item.body}</p>
                    {item.attachments.length > 0 && sessionId && token ? (
                      <div className="peer-chat-attachments">
                        {item.attachments.map((attachment) => (
                          <PeerChatAttachment
                            sessionId={sessionId}
                            messageId={item.id}
                            attachment={attachment}
                            token={token}
                            onError={onAttachmentError}
                            key={attachment.id}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })
          )}
        </div>
        <form
          className={`peer-chat-composer ${draggingChatFiles ? "dragging" : ""}`}
          onSubmit={(event) => {
            event.preventDefault();
            onSendChat();
          }}
          onDragEnter={(event) => {
            event.preventDefault();
            if (approved && roomOpen) onDraggingChatFilesChange(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              onDraggingChatFilesChange(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            onDraggingChatFilesChange(false);
            if (approved && roomOpen) {
              onAddChatAttachments(event.dataTransfer.files);
            }
          }}
        >
          <input
            ref={chatAttachmentInputRef}
            className="visually-hidden"
            type="file"
            multiple
            disabled={
              !approved ||
              submitting ||
              preparingChatAttachments ||
              !roomOpen
            }
            tabIndex={-1}
            onChange={(event) => {
              if (event.currentTarget.files) {
                onAddChatAttachments(event.currentTarget.files);
              }
              event.currentTarget.value = "";
            }}
          />
          {preparingChatAttachments ? (
            <div className="attachment-preparing" role="status">
              <Spinner size="tiny" />
              <span>正在压缩图片…</span>
            </div>
          ) : null}
          {pendingChatAttachments.length > 0 ? (
            <div
              className="pending-attachments peer-chat-pending-attachments"
              aria-label="待发送聊天附件"
            >
              {pendingChatAttachments.map((attachment) => (
                <span key={attachment.id}>
                  <AttachRegular aria-hidden="true" />
                  <span title={attachment.file.name}>{attachment.file.name}</span>
                  <small>{attachmentSizeLabel(attachment)}</small>
                  <Button
                    type="button"
                    appearance="subtle"
                    size="small"
                    icon={<DeleteRegular />}
                    title={`移除 ${attachment.file.name}`}
                    aria-label={`移除 ${attachment.file.name}`}
                    onClick={() => onRemoveChatAttachment(attachment.id)}
                  />
                </span>
              ))}
            </div>
          ) : null}
          <div className="peer-chat-composer-row">
            <Button
              type="button"
              appearance="subtle"
              icon={<AttachRegular />}
              title="发送文件或图片"
              aria-label="发送文件或图片"
              disabled={
                !approved ||
                submitting ||
                preparingChatAttachments ||
                !roomOpen
              }
              onClick={() => chatAttachmentInputRef.current?.click()}
            />
            <Input
              ref={chatInputRef}
              value={chatDraft}
              aria-label="输入协作聊天消息"
              placeholder={
                !roomOpen
                  ? "房间已关闭"
                  : approved
                    ? "给协作者发消息"
                    : "等待批准"
              }
              disabled={!approved || submitting || !roomOpen}
              onChange={(_, data) => onChatDraftChange(data.value)}
              onPaste={(event) => {
                if (event.clipboardData.files.length > 0) {
                  event.preventDefault();
                  onAddChatAttachments(event.clipboardData.files);
                }
              }}
            />
            <Button
              type="submit"
              appearance="primary"
              icon={<SendRegular />}
              aria-label="发送协作聊天消息"
              disabled={!approved || submitting || !roomOpen || !canSendChat}
            />
          </div>
        </form>
      </section>
    </aside>
  );
}
