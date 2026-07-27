import type { CodexRuntimeStatus } from "./codex.js";
import type { Member, Session, WorkspaceFileAccess } from "./collaboration.js";

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

/**
 * A safe file-activity summary imported from Codex. Diff bodies are deliberately
 * excluded; browser file access still resolves against the approved workspace snapshot.
 */
export interface CodexFileChange {
  operationId: string;
  taskId?: string;
  path: string;
  previousPath?: string | null;
  kind: CodexFileChangeKind;
  lifecycle: CodexFileChangeLifecycle;
  additions: number;
  deletions: number;
  line?: number;
  column?: number;
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
