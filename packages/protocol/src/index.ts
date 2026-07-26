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
export type CodexCustomFileAccess =
  | "read-only"
  | "workspace-write"
  | "full-access";
export type CodexCustomApprovalPolicy = "on-request" | "never";
export interface CodexCustomPermissions {
  fileAccess: CodexCustomFileAccess;
  approvalPolicy: CodexCustomApprovalPolicy;
}
export const DEFAULT_CODEX_CUSTOM_PERMISSIONS: CodexCustomPermissions = {
  fileAccess: "workspace-write",
  approvalPolicy: "on-request",
};
export type CodexModelReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";
export type CodexReasoningEffort =
  | "follow-desktop"
  | CodexModelReasoningEffort;
export type CodexSpeed = "follow-desktop" | "standard" | "fast";
export type CodexRuntimeStatus = "unavailable" | "idle" | "running";

export const CODEX_MODEL_OPTIONS = [
  {
    id: "gpt-5.6-sol",
    label: "5.6 Sol",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    supportsFast: true,
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-5.6-terra",
    label: "5.6 Terra",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    supportsFast: true,
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-5.6-luna",
    label: "5.6 Luna",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsFast: true,
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-5.5",
    label: "5.5",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsFast: true,
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-5.4",
    label: "5.4",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsFast: true,
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-5.4-mini",
    label: "5.4 Mini",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsFast: false,
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "5.3 Codex Spark",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsFast: false,
    inputModalities: ["text"],
  },
] as const;

export type CodexModelId = (typeof CODEX_MODEL_OPTIONS)[number]["id"];

export function normalizeCodexModelId(value: string): CodexModelId | null {
  const option = CODEX_MODEL_OPTIONS.find(
    (candidate) => candidate.id === value || candidate.label === value,
  );
  return option?.id ?? null;
}

export function getCodexModelOption(model: CodexModelId | null | undefined) {
  if (!model) return null;
  return CODEX_MODEL_OPTIONS.find((candidate) => candidate.id === model) ?? null;
}

export function codexModelSupportsReasoningEffort(
  model: CodexModelId | null | undefined,
  effort: CodexReasoningEffort,
): boolean {
  if (!model || effort === "follow-desktop") return true;
  const option = getCodexModelOption(model);
  return Boolean(
    option?.reasoningEfforts.some(
      (candidate) => candidate === (effort as CodexModelReasoningEffort),
    ),
  );
}

export function codexModelSupportsFast(
  model: CodexModelId | null | undefined,
): boolean {
  return getCodexModelOption(model)?.supportsFast ?? true;
}

export function codexModelSupportsImages(
  model: CodexModelId | null | undefined,
): boolean {
  const option = getCodexModelOption(model);
  return option ? option.inputModalities.some((modality) => modality === "image") : true;
}

export interface CodexPromptOptions {
  accessMode: CodexAccessMode;
  customPermissions: CodexCustomPermissions | null;
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

export interface RealtimeTicketResponse {
  ticket: string;
  expiresAt: string;
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
