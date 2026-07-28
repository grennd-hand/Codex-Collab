import type { CodexRuntimeStatus } from "./codex.js";
import type { Member, Session, WorkspaceFileAccess } from "./collaboration.js";

export const MAX_WORKSPACE_HISTORY_ENTRIES = 1_000;
export const MAX_WORKSPACE_HISTORY_TEXT_LENGTH = 2_000_000;

export interface CodexThreadCatalogEntry {
  id: string;
  name: string | null;
  preview: string;
  updatedAt: number | null;
}

export type CodexFileChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed";

export type CodexFileChangeLifecycle = "running" | "completed" | "failed";

export type CodexFileChangeActorType = "codex" | "owner" | "member" | "host";

export interface CodexFileChangeActor {
  type: CodexFileChangeActorType;
  id?: string;
  displayName?: string;
}

export interface CodexFileChangeRange {
  startLine: number;
  startColumn?: number;
  endLine: number;
  endColumn?: number;
}

export interface CodexFileChangeDiff {
  format: "unified";
  text: string;
  truncated: boolean;
}

export const MAX_CODEX_FILE_CHANGE_DIFF_LENGTH = 64_000;

/**
 * A safe file-activity summary imported from Codex. Optional diff text is admitted only
 * after Relay validation and never replaces approved-root workspace access checks.
 */
export interface CodexFileChange {
  operationId: string;
  taskId?: string;
  actor?: CodexFileChangeActor;
  timestamp?: string;
  path: string;
  previousPath?: string | null;
  kind: CodexFileChangeKind;
  lifecycle: CodexFileChangeLifecycle;
  additions: number;
  deletions: number;
  line?: number;
  column?: number;
  range?: CodexFileChangeRange;
  beforeSha256?: string | null;
  afterSha256?: string | null;
  /** String input is accepted for legacy publishers; Relay responses normalize it to an object. */
  diff?: CodexFileChangeDiff | string;
}

export interface CodexRecordEntry {
  id: string;
  role: "user" | "assistant" | "reasoning" | "command";
  phase?: "commentary" | "final_answer";
  text: string;
  createdAt: string | null;
  fileChanges?: CodexFileChange[];
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

export type WorkspaceFileOperationKind = "read" | "write" | "mkdir" | "rename";
export type WorkspaceFileOperationStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export interface WorkspaceFileOperation {
  id: string;
  sessionId: string;
  requestedByMemberId: string;
  requestedByDisplayName: string;
  hostGeneration: string;
  kind: WorkspaceFileOperationKind;
  path: string;
  destinationPath: string | null;
  expectedSha256: string | null;
  status: WorkspaceFileOperationStatus;
  resultFileMetadata: WorkspaceFile | null;
  resultFile: WorkspaceFileContent | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkspaceFileOperationClaim
  extends Omit<WorkspaceFileOperation, "expectedSha256"> {
  /** Write preconditions are withheld until the current host confirms the lease. */
  expectedSha256: null;
  leaseId: string;
  leaseExpiresAt: string;
}

export interface WorkspaceFileOperationConfirmation
  extends Omit<WorkspaceFileOperationClaim, "expectedSha256"> {
  expectedSha256: string | null;
  requestContent: string | null;
}

export interface ReleaseWorkspaceFileOperationLeaseRequest {
  leaseId: string;
}

export interface WorkspaceFileOperationEvent {
  operationId: string;
  requestedByMemberId: string;
  status: WorkspaceFileOperationStatus;
}

export type CreateWorkspaceFileOperationRequest =
  | {
      kind: "read";
      path: string;
    }
  | {
      kind: "write";
      path: string;
      content: string;
      /** Existing file SHA-256, or an empty string to require that a new file does not exist. */
      expectedSha256: string;
    }
  | {
      kind: "mkdir";
      path: string;
    }
  | {
      kind: "rename";
      path: string;
      destinationPath: string;
      /** Existing file hash, or null when renaming a directory. */
      expectedSha256: string | null;
    };

export interface UpdateMemberWorkspaceFileAccessRequest {
  workspaceFileAccess: WorkspaceFileAccess;
}

export interface WorkspaceSummary {
  hostConnected: boolean;
  hostGeneration?: string | null;
  hostDeviceLabel: string | null;
  rootLabel: string | null;
  threads: CodexThreadCatalogEntry[];
  selectedThreadId: string | null;
  selectedThread: CodexThreadCatalogEntry | null;
  history: CodexRecordEntry[];
  files: WorkspaceFile[];
  directories?: string[];
  codexRuntimeStatus: CodexRuntimeStatus;
  syncedAt: string | null;
}

export interface WorkspaceOverview extends Omit<WorkspaceSummary, "history"> {
  historyCount: number;
}

export interface WorkspaceSyncState extends Omit<WorkspaceOverview, "files"> {
  fileCount: number;
  cachedThreadIds?: string[];
}

export interface WorkspaceHistoryResult {
  selectedThreadId: string | null;
  history: CodexRecordEntry[];
  syncedAt: string | null;
}

export interface WorkspaceHistoryPageItem {
  key: string;
  entry: CodexRecordEntry;
  groupKey?: string | null;
}

export interface WorkspaceHistoryPage {
  selectedThreadId: string | null;
  items: WorkspaceHistoryPageItem[];
  totalCount: number;
  hasOlder: boolean;
  olderCursor: string | null;
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
    | "workspace.updated"
    | "file.operation.updated";
  sessionId: string;
  payload: unknown;
  sentAt: string;
}

export interface RealtimeTicketResponse {
  ticket: string;
  expiresAt: string;
}
