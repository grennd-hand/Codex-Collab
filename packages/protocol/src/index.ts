export const PROTOCOL_VERSION = "v1" as const;

export type MemberRole = "owner" | "editor";
export type MemberStatus = "pending" | "approved" | "rejected" | "revoked";
export type MessageKind = "chat" | "codex_prompt" | "system";

export interface Session {
  id: string;
  name: string;
  ownerMemberId: string;
  createdAt: string;
}

export interface Member {
  id: string;
  sessionId: string;
  displayName: string;
  deviceLabel: string | null;
  role: MemberRole;
  status: MemberStatus;
  createdAt: string;
  approvedAt: string | null;
}

export interface Message {
  id: string;
  sessionId: string;
  senderMemberId: string;
  senderDisplayName: string;
  kind: MessageKind;
  body: string;
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

export interface CodexThreadCatalogEntry {
  id: string;
  name: string | null;
  preview: string;
  updatedAt: number | null;
}

export interface CodexRecordEntry {
  id: string;
  role: "user" | "assistant" | "reasoning" | "command";
  text: string;
  createdAt: string | null;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  modifiedAt: string;
  sha256: string;
}

export interface WorkspaceFileContent extends WorkspaceFile {
  content: string;
}

export interface WorkspaceSummary {
  hostConnected: boolean;
  hostDeviceLabel: string | null;
  rootLabel: string | null;
  threads: CodexThreadCatalogEntry[];
  selectedThreadId: string | null;
  selectedThread: CodexThreadCatalogEntry | null;
  history: CodexRecordEntry[];
  files: WorkspaceFile[];
  syncedAt: string | null;
}

export interface CreateHostPairingResponse {
  sessionId: string;
  pairingToken: string;
  expiresAt: string;
}

export interface ClaimHostPairingResponse {
  session: Session;
  owner: Member;
  memberToken: string;
}

export interface RealtimeEnvelope {
  type: "ready" | "member.updated" | "message.created" | "workspace.updated";
  sessionId: string;
  payload: unknown;
  sentAt: string;
}

export class ProtocolError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function requiredString(value: unknown, field: string, maxLength = 10_000): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProtocolError(400, "invalid_request", `${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ProtocolError(400, "invalid_request", `${field} is too long`);
  }
  return normalized;
}

export function optionalInteger(
  value: unknown,
  fallback: number,
  field: string,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ProtocolError(400, "invalid_request", `${field} must be between ${min} and ${max}`);
  }
  return value as number;
}
