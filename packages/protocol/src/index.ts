export const PROTOCOL_VERSION = "v1" as const;

export type MemberRole = "owner" | "editor";
export type MemberStatus = "pending" | "approved" | "rejected" | "revoked";
export type RoomStatus = "open" | "closed";
export type MessageKind = "chat" | "codex_prompt" | "codex_stop" | "system";
export type MessageDeliveryStatus = "queued" | "submitted" | "completed" | "failed";
export type CodexAccessMode =
  | "follow-desktop"
  | "request-approval"
  | "auto"
  | "full-access"
  | "custom";
export type CodexReasoningEffort =
  | "follow-desktop"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type CodexSpeed = "follow-desktop" | "standard" | "fast";
export type CodexRuntimeStatus = "unavailable" | "idle" | "running";

export const CODEX_MODEL_OPTIONS = [
  { id: "gpt-5.6-sol", label: "5.6 Sol" },
  { id: "gpt-5.6-terra", label: "5.6 Terra" },
  { id: "gpt-5.6-luna", label: "5.6 Luna" },
  { id: "gpt-5.5", label: "5.5" },
  { id: "gpt-5.4", label: "5.4" },
  { id: "gpt-5.4-mini", label: "5.4 Mini" },
  { id: "gpt-5.3-codex-spark", label: "5.3 Codex Spark" },
] as const;

export type CodexModelId = (typeof CODEX_MODEL_OPTIONS)[number]["id"];

export function normalizeCodexModelId(value: string): CodexModelId | null {
  const option = CODEX_MODEL_OPTIONS.find(
    (candidate) => candidate.id === value || candidate.label === value,
  );
  return option?.id ?? null;
}

export interface CodexPromptOptions {
  accessMode: CodexAccessMode;
  model: CodexModelId | null;
  reasoningEffort: CodexReasoningEffort;
  speed: CodexSpeed;
  planMode: boolean;
}

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
  attachments: MessageAttachment[];
  codexOptions: CodexPromptOptions | null;
  deliveryStatus: MessageDeliveryStatus | null;
  codexTurnId: string | null;
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
  codexRuntimeStatus: CodexRuntimeStatus;
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
  type:
    | "ready"
    | "session.updated"
    | "member.updated"
    | "message.created"
    | "workspace.updated";
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
