import { randomUUID } from "node:crypto";
import {
  type WorkspaceFileOperation,
  type WorkspaceFileOperationClaim,
  type WorkspaceFileOperationConfirmation,
  ProtocolError,
} from "@codex-collab/protocol";
import { WorkspaceFileOperationStore } from "./workspace-file-operation-store.js";
import {
  type MemberRow,
  type WorkspaceFileOperationRow,
  FILE_OPERATION_LEASE_MS,
  now,
} from "../storage/session-store-types.js";

export class WorkspaceOperationLeaseStore extends WorkspaceFileOperationStore {
  claimNextWorkspaceFileOperation(
    sessionId: string,
    memberToken: string,
  ): {
    operation: WorkspaceFileOperationClaim | null;
    rejected: WorkspaceFileOperation[];
  } {
    const host = this.requireCurrentHost(sessionId, memberToken);
    // A claim is the host's bounded authorization lease. Permission and current-host
    // generation are rechecked when claiming; a stale worker cannot later complete it.
    const staleBefore = new Date(Date.now() - FILE_OPERATION_LEASE_MS).toISOString();
    const claimedAt = now();
    const rejected: WorkspaceFileOperation[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          UPDATE workspace_file_operations
          SET status = 'queued', started_at = NULL, lease_id = NULL,
              lease_expires_at = NULL, lease_confirmed_at = NULL
          WHERE session_id = ? AND host_generation = ?
            AND status = 'processing' AND started_at < ?
        `)
        .run(sessionId, host.generation, staleBefore);

      const inFlight = this.db
        .prepare(`
          SELECT 1 AS present FROM workspace_file_operations
          WHERE session_id = ? AND host_generation = ? AND status = 'processing'
          LIMIT 1
        `)
        .get(sessionId, host.generation) as { present: number } | undefined;
      if (inFlight) {
        this.db.exec("COMMIT");
        return { operation: null, rejected };
      }

      for (;;) {
        const row = this.db
          .prepare(`
            SELECT * FROM workspace_file_operations
            WHERE session_id = ? AND host_generation = ? AND status = 'queued'
            ORDER BY requested_at ASC, id ASC LIMIT 1
          `)
          .get(sessionId, host.generation) as WorkspaceFileOperationRow | undefined;
        if (!row) {
          this.db.exec("COMMIT");
          return { operation: null, rejected };
        }
        const requester = this.db
          .prepare(`
            SELECT id, session_id, display_name, device_label, role, status,
                   workspace_file_access, created_at, approved_at
            FROM members WHERE session_id = ? AND id = ?
          `)
          .get(sessionId, row.requested_by_member_id) as MemberRow | undefined;
        const allowed =
          requester?.status === "approved" &&
          (row.kind === "read" ||
            requester.role === "owner" ||
            requester.workspace_file_access === "workspace-write");
        if (!allowed) {
          const errorCode =
            requester?.status === "approved"
              ? "workspace_read_only"
              : "member_not_approved";
          const errorMessage =
            errorCode === "workspace_read_only"
              ? "Workspace write access was removed before the host processed this operation"
              : "The requesting member is no longer approved";
          this.db
            .prepare(`
              UPDATE workspace_file_operations
              SET status = 'failed', request_content = NULL,
                  error_code = ?, error_message = ?, completed_at = ?
              WHERE id = ? AND status = 'queued'
            `)
            .run(errorCode, errorMessage, claimedAt, row.id);
          rejected.push(this.workspaceFileOperationById(sessionId, row.id));
          continue;
        }
        const leaseId = randomUUID();
        const leaseExpiresAt = new Date(Date.now() + FILE_OPERATION_LEASE_MS).toISOString();
        const claimed = this.db
          .prepare(`
            UPDATE workspace_file_operations
            SET status = 'processing', started_at = ?, lease_id = ?, lease_expires_at = ?,
                lease_confirmed_at = NULL, error_code = NULL, error_message = NULL
            WHERE id = ? AND session_id = ? AND host_generation = ? AND status = 'queued'
          `)
          .run(claimedAt, leaseId, leaseExpiresAt, row.id, sessionId, host.generation);
        if (claimed.changes !== 1) continue;
        const current = this.workspaceFileOperationRowById(sessionId, row.id);
        this.db.exec("COMMIT");
        return {
          operation: {
            ...this.toWorkspaceFileOperation(current),
            expectedSha256: null,
            leaseId,
            leaseExpiresAt,
          },
          rejected,
        };
      }
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  confirmWorkspaceFileOperationLease(
    sessionId: string,
    memberToken: string,
    operationId: string,
    leaseId: string,
  ): WorkspaceFileOperationConfirmation {
    const host = this.requireCurrentHost(sessionId, memberToken);
    this.db.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    try {
      const row = this.workspaceFileOperationRowById(sessionId, operationId);
      const confirmedAt = now();
      if (
        row.status !== "processing" ||
        row.host_generation !== host.generation ||
        row.lease_id !== leaseId ||
        !row.lease_expires_at ||
        Date.parse(row.lease_expires_at) <= Date.parse(confirmedAt)
      ) {
        throw new ProtocolError(
          409,
          "workspace_operation_lease_expired",
          "The workspace file operation lease expired before host execution",
        );
      }
      const permissionError = this.workspaceOperationPermissionError(row);
      if (permissionError) {
        this.db
          .prepare(`
            UPDATE workspace_file_operations
            SET status = 'failed', request_content = NULL, lease_id = NULL,
                lease_expires_at = NULL, lease_confirmed_at = NULL,
                error_code = ?, error_message = ?, completed_at = ?
            WHERE id = ? AND session_id = ? AND status = 'processing'
              AND host_generation = ? AND lease_id = ?
          `)
          .run(
            permissionError.code,
            permissionError.message,
            confirmedAt,
            operationId,
            sessionId,
            host.generation,
            leaseId,
          );
        this.db.exec("COMMIT");
        transactionOpen = false;
        throw new ProtocolError(403, permissionError.code, permissionError.message);
      }
      if (row.kind === "write") {
        if (row.request_content === null || row.expected_sha256 === null) {
          throw new ProtocolError(
            409,
            "invalid_workspace_operation",
            "The queued write operation is missing required data",
          );
        }
        const existing = this.db
          .prepare("SELECT 1 AS present FROM workspace_files WHERE session_id = ? AND path = ?")
          .get(sessionId, row.path) as { present: number } | undefined;
        const missingExistingFile = row.expected_sha256 !== "" && !existing;
        const occupiedNewFilePath = row.expected_sha256 === "" && Boolean(existing);
        if (missingExistingFile || occupiedNewFilePath) {
          const errorCode = occupiedNewFilePath
            ? "file_conflict"
            : "workspace_file_not_found";
          const errorMessage = occupiedNewFilePath
            ? "A file now exists at the requested path"
            : "The file is no longer present in the shared workspace";
          this.db
            .prepare(`
              UPDATE workspace_file_operations
              SET status = 'failed', request_content = NULL, lease_id = NULL,
                  lease_expires_at = NULL, lease_confirmed_at = NULL,
                  error_code = ?, error_message = ?,
                  completed_at = ?
              WHERE id = ? AND session_id = ? AND status = 'processing'
                AND host_generation = ? AND lease_id = ?
            `)
            .run(
              errorCode,
              errorMessage,
              confirmedAt,
              operationId,
              sessionId,
              host.generation,
              leaseId,
            );
          this.db.exec("COMMIT");
          transactionOpen = false;
          throw new ProtocolError(
            409,
            errorCode,
            errorMessage,
          );
        }
        this.assertWorkspaceFileCapacity(
          sessionId,
          row.path,
          Buffer.byteLength(row.request_content),
        );
      }
      const confirmed = this.db
        .prepare(`
          UPDATE workspace_file_operations
          SET lease_confirmed_at = COALESCE(lease_confirmed_at, ?)
          WHERE id = ? AND session_id = ? AND status = 'processing'
            AND host_generation = ? AND lease_id = ? AND lease_expires_at > ?
        `)
        .run(
          confirmedAt,
          operationId,
          sessionId,
          host.generation,
          leaseId,
          confirmedAt,
        );
      if (confirmed.changes !== 1) {
        throw new ProtocolError(
          409,
          "workspace_operation_lease_expired",
          "The workspace file operation lease expired before host execution",
        );
      }
      const current = this.workspaceFileOperationRowById(sessionId, operationId);
      this.db.exec("COMMIT");
      transactionOpen = false;
      return {
        ...this.toWorkspaceFileOperation(current),
        leaseId,
        leaseExpiresAt: current.lease_expires_at!,
        requestContent: current.request_content,
      };
    } catch (error) {
      if (transactionOpen) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  releaseWorkspaceFileOperationLease(
    sessionId: string,
    memberToken: string,
    operationId: string,
    leaseId: string,
  ): WorkspaceFileOperation {
    this.db.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    try {
      const host = this.requireCurrentHost(sessionId, memberToken);
      const row = this.workspaceFileOperationRowById(sessionId, operationId);
      if (
        row.status !== "processing" ||
        row.host_generation !== host.generation ||
        row.lease_id !== leaseId
      ) {
        throw new ProtocolError(
          409,
          "workspace_operation_not_processing",
          "The file operation is not currently claimed by this lease",
        );
      }
      const released = this.db
        .prepare(`
          UPDATE workspace_file_operations
          SET status = 'queued', started_at = NULL, lease_id = NULL,
              lease_expires_at = NULL, lease_confirmed_at = NULL
          WHERE id = ? AND session_id = ? AND host_generation = ?
            AND status = 'processing' AND lease_id = ?
        `)
        .run(operationId, sessionId, host.generation, leaseId);
      if (released.changes !== 1) {
        throw new ProtocolError(
          409,
          "workspace_operation_not_processing",
          "The file operation is no longer claimed by this lease",
        );
      }
      const operation = this.workspaceFileOperationById(sessionId, operationId);
      this.db.exec("COMMIT");
      transactionOpen = false;
      return operation;
    } catch (error) {
      if (transactionOpen) this.db.exec("ROLLBACK");
      throw error;
    }
  }

}
