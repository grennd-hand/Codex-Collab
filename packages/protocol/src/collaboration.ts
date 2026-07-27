import type { CodexPromptOptions } from "./codex.js";

export type MemberRole = "owner" | "editor";
export type MemberStatus = "pending" | "approved" | "rejected" | "revoked";
export type WorkspaceFileAccess = "read-only" | "workspace-write";
export type RoomStatus = "open" | "closed";
export type MessageKind = "chat" | "codex_prompt" | "codex_stop" | "system";
export type MessageDeliveryStatus = "queued" | "submitted" | "completed" | "failed";

export interface MessageAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

export interface MessageAttachmentInput {
  name: string;
  mediaType: string;
  size: number;
  dataBase64: string;
}

export const MAX_MESSAGE_ATTACHMENT_COUNT = 8;
export const MAX_MESSAGE_ATTACHMENT_SIZE = 4_000_000;
export const MAX_MESSAGE_ATTACHMENT_TOTAL_SIZE = 6_000_000;

export interface Session {
  id: string;
  name: string;
  ownerMemberId: string;
  roomStatus: RoomStatus;
  createdAt: string;
}

export interface UpdateRoomStatusRequest {
  roomStatus: RoomStatus;
}

export interface UpdateRoomStatusResponse {
  session: Session;
}

export interface Member {
  id: string;
  sessionId: string;
  displayName: string;
  deviceLabel: string | null;
  role: MemberRole;
  status: MemberStatus;
  workspaceFileAccess: WorkspaceFileAccess;
  createdAt: string;
  approvedAt: string | null;
}

export interface Account {
  id: string;
  displayName: string;
  createdAt: string;
}

export interface AccountRoom {
  session: Session;
  member: Member;
  lastUsedAt: string | null;
}

export interface AccountProfileResponse {
  account: Account;
  rooms: AccountRoom[];
  csrfToken: string;
}

export interface RestoreAccountRoomResponse {
  session: Session;
  member: Member;
  memberToken: string;
}

export interface Message {
  id: string;
  sessionId: string;
  senderMemberId: string;
  senderDisplayName: string;
  kind: MessageKind;
  body: string;
  attachments: MessageAttachment[];
  codexOptions: CodexPromptOptions | null;
  deliveryStatus: MessageDeliveryStatus | null;
  codexTurnId: string | null;
  workspaceThreadId: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CreateSessionRequest {
  name: string;
  ownerDisplayName: string;
  deviceLabel?: string;
}

export interface CreateSessionResponse {
  session: Session;
  owner: Member;
  memberToken: string;
  recoveryKey: string;
}

export interface RecoverSessionRequest {
  sessionId: string;
  recoveryKey: string;
  deviceLabel?: string;
}

export interface RecoverSessionResponse {
  session: Session;
  owner: Member;
  memberToken: string;
}

export interface CreateInviteRequest {
  expiresInMinutes?: number;
  maxUses?: number;
}

export interface CreateInviteResponse {
  sessionId: string;
  inviteToken: string;
  inviteLink: string;
  expiresAt: string;
}

export interface JoinInviteRequest {
  inviteToken: string;
  displayName: string;
  deviceLabel?: string;
}

export interface JoinInviteResponse {
  session: Session;
  member: Member;
  memberToken: string;
}
