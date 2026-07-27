import { createHash } from "node:crypto";
import {
  type Account,
  type CodexPromptOptions,
  type CodexRecordEntry,
  type CodexRuntimeStatus,
  type CodexThreadCatalogEntry,
  type Member,
  type MemberStatus,
  type MessageDeliveryStatus,
  type MessageKind,
  type RoomStatus,
  type Session,
  type WorkspaceFile,
  type WorkspaceFileAccess,
  type WorkspaceFileOperationKind,
  type WorkspaceFileOperationStatus,
  codexConfigRelativePath,
  isPublishableCodexConfigPath,
  isPublishableWorkspacePath,
  ProtocolError,
} from "@codex-collab/protocol";

export interface MemberRow {
  id: string;
  session_id: string;
  display_name: string;
  device_label: string | null;
  role: "owner" | "editor";
  status: MemberStatus;
  workspace_file_access: WorkspaceFileAccess;
  created_at: string;
  approved_at: string | null;
}

export interface SessionRow {
  id: string;
  name: string;
  owner_member_id: string;
  room_status: RoomStatus;
  created_at: string;
}

export interface MessageRow {
  id: string;
  session_id: string;
  sender_member_id: string;
  sender_display_name: string;
  kind: MessageKind;
  body: string;
  codex_options_json: string | null;
  delivery_status: MessageDeliveryStatus | null;
  codex_turn_id: string | null;
  selected_thread_id: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface MessageAttachmentMetadataRow {
  id: string;
  message_id: string;
  name: string;
  media_type: string;
  size: number;
}

export interface MessageAttachmentRow extends MessageAttachmentMetadataRow {
  content: Uint8Array;
}

export interface InviteRow {
  id: string;
  session_id: string;
  expires_at: string;
  max_uses: number;
  uses: number;
  room_status: RoomStatus;
}

export interface HostPairingRow {
  id: string;
  session_id: string;
  expires_at: string;
  used_at: string | null;
}

export interface WorkspaceStateRow {
  session_id: string;
  host_device_label: string;
  root_label: string;
  host_token_id: string | null;
  host_generation: string | null;
  catalog_json: string;
  selected_thread_id: string | null;
  history_json: string;
  history_count: number;
  codex_runtime_status: CodexRuntimeStatus;
  synced_at: string | null;
}

export interface WorkspaceFileMetadataRow {
  path: string;
  size: number;
  modified_at: string;
  sha256: string;
}

export interface WorkspaceFileRow extends WorkspaceFileMetadataRow {
  content: string;
}

export interface WorkspaceFileOperationRow {
  id: string;
  session_id: string;
  requested_by_member_id: string;
  requested_by_display_name: string;
  host_generation: string | null;
  kind: WorkspaceFileOperationKind;
  path: string;
  request_content: string | null;
  request_size: number | null;
  expected_sha256: string | null;
  status: WorkspaceFileOperationStatus;
  result_content: string | null;
  result_size: number | null;
  result_modified_at: string | null;
  result_sha256: string | null;
  error_code: string | null;
  error_message: string | null;
  requested_at: string;
  started_at: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
  lease_confirmed_at: string | null;
  completed_at: string | null;
}

export interface AccountRow {
  id: string;
  display_name: string;
  created_at: string;
}

export interface AccountChallengeRow {
  kind: "registration" | "authentication";
  challenge: string;
  account_id: string | null;
  display_name: string | null;
  expected_origin: string;
  rp_id: string;
  expires_at: string;
}

export interface AccountCredentialRow {
  id: string;
  account_id: string;
  public_key: Uint8Array;
  counter: number;
  transports_json: string;
}

export interface AccountRoomRow {
  session_id: string;
  session_name: string;
  owner_member_id: string;
  room_status: RoomStatus;
  session_created_at: string;
  member_id: string;
  member_display_name: string;
  member_device_label: string | null;
  member_role: "owner" | "editor";
  member_status: MemberStatus;
  member_workspace_file_access: WorkspaceFileAccess;
  member_created_at: string;
  member_approved_at: string | null;
  last_used_at: string | null;
}

export interface AccountChallenge {
  kind: "registration" | "authentication";
  challenge: string;
  accountId: string | null;
  displayName: string | null;
  expectedOrigin: string;
  rpId: string;
}

export interface StoredAccountCredential {
  id: string;
  accountId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
}

export interface AccountSessionIdentity {
  account: Account;
  accountSessionId: string;
  expiresAt: string;
}

export function now(): string {
  return new Date().toISOString();
}

export function normalizeWorkspaceOperationPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.length > 500 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("\0")
  ) {
    throw new ProtocolError(400, "unsafe_workspace_path", "Use a safe relative file path");
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        segment.includes(":") ||
        /[\u0000-\u001f<>"|?*]/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
    )
  ) {
    throw new ProtocolError(400, "unsafe_workspace_path", "Use a safe relative file path");
  }
  const configRelativePath = codexConfigRelativePath(normalized);
  if (configRelativePath) {
    if (!isPublishableCodexConfigPath(configRelativePath)) {
      throw new ProtocolError(
        403,
        "workspace_file_not_shared",
        "This file is not available to the collaboration editor",
      );
    }
    return `.codex/${configRelativePath}`;
  }
  if (!isPublishableWorkspacePath(normalized)) {
    throw new ProtocolError(
      403,
      "workspace_file_not_shared",
      "This file is not available to the collaboration editor",
    );
  }
  return normalized;
}

export function contentSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export const MAX_ACTIVE_FILE_OPERATIONS_PER_MEMBER = 8;
export const MAX_ACTIVE_FILE_OPERATIONS_PER_SESSION = 64;
export const MAX_FILE_OPERATION_AUDIT_ROWS_PER_SESSION = 500;
export const MAX_FILE_OPERATION_RESULT_CONTENT_COUNT = 20;
export const MAX_FILE_OPERATION_RESULT_CONTENT_BYTES = 10_000_000;
export const FILE_OPERATION_LEASE_MS = 30_000;
export const MAX_WORKSPACE_FILE_COUNT = 600;
export const MAX_WORKSPACE_FILE_BYTES = 5_000_000;
export const MAX_MEMBER_WRITE_OPERATIONS_PER_MINUTE = 30;
export const MAX_MEMBER_WRITE_BYTES_PER_MINUTE = 4_000_000;

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    ownerMemberId: row.owner_member_id,
    roomStatus: row.room_status,
    createdAt: row.created_at,
  };
}

export function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    sessionId: row.session_id,
    displayName: row.display_name,
    deviceLabel: row.device_label,
    role: row.role,
    status: row.status,
    workspaceFileAccess:
      row.role === "owner" ? "workspace-write" : row.workspace_file_access,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}


