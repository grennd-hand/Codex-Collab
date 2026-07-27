import {
  type WorkspaceFileContent,
  type WorkspaceFileOperation,
  containsLikelySecret,
  ProtocolError,
} from "@codex-collab/protocol";
import { WorkspaceOperationLeaseStore } from "./workspace-operation-lease-store.js";
import {
  contentSha256,
  normalizeWorkspaceOperationPath,
  now,
} from "../storage/session-store-types.js";

export class WorkspaceOperationCompletionStore extends WorkspaceOperationLeaseStore {
  completeWorkspaceFileOperation(
    sessionId: string,
    memberToken: string,
    operationId: string,
    input:
      | { status: "completed"; leaseId: string; file: WorkspaceFileContent }
      | {
          status: "failed";
          leaseId: string;
          errorCode: string;
          errorMessage: string;
          file?: WorkspaceFileContent | null;
        },
  ): WorkspaceFileOperation {
    const host = this.requireCurrentHost(sessionId, memberToken);
    const row = this.workspaceFileOperationRowById(sessionId, operationId);
    if (
      row.status !== "processing" ||
      row.host_generation !== host.generation ||
      row.lease_id !== input.leaseId ||
      !row.lease_expires_at ||
      !row.lease_confirmed_at ||
      Date.parse(row.lease_expires_at) <= Date.now()
    ) {
      throw new ProtocolError(
        409,
        "workspace_operation_not_processing",
        "The file operation is not currently claimed by the host",
      );
    }
    const permissionError = this.workspaceOperationPermissionError(row);
    if (permissionError) {
      throw new ProtocolError(403, permissionError.code, permissionError.message);
    }
    const file = input.file ?? null;
    if (file) {
      const normalizedPath = normalizeWorkspaceOperationPath(file.path);
      if (normalizedPath !== row.path) {
        throw new ProtocolError(
          400,
          "workspace_operation_path_mismatch",
          "The host result path does not match the requested path",
        );
      }
      const size = Buffer.byteLength(file.content);
      if (size > 2_000_000 || size !== file.size) {
        throw new ProtocolError(400, "invalid_workspace_file", "Host file size is invalid");
      }
      if (contentSha256(file.content) !== file.sha256) {
        throw new ProtocolError(400, "invalid_workspace_file", "Host file hash is invalid");
      }
      if (Number.isNaN(Date.parse(file.modifiedAt))) {
        throw new ProtocolError(
          400,
          "invalid_workspace_file",
          "Host file modification time is invalid",
        );
      }
      if (containsLikelySecret(file.content)) {
        throw new ProtocolError(
          403,
          "workspace_file_not_shared",
          "This file is not available to the collaboration editor",
        );
      }
    }
    const errorCode =
      input.status === "failed" ? input.errorCode.trim().slice(0, 120) : null;
    const errorMessage =
      input.status === "failed" ? input.errorMessage.trim().slice(0, 1_000) : null;
    if (input.status === "failed" && (!errorCode || !errorMessage)) {
      throw new ProtocolError(
        400,
        "invalid_workspace_operation_result",
        "Failed operations require an error code and message",
      );
    }
    const completedAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (file) {
        this.assertWorkspaceFileCapacity(sessionId, row.path, file.size);
      }
      const updated = this.db
        .prepare(`
          UPDATE workspace_file_operations
          SET status = ?, request_content = NULL,
              result_content = ?, result_size = ?, result_modified_at = ?, result_sha256 = ?,
              error_code = ?, error_message = ?, completed_at = ?, lease_id = NULL,
              lease_expires_at = NULL, lease_confirmed_at = NULL
          WHERE id = ? AND session_id = ? AND host_generation = ?
            AND status = 'processing' AND lease_id = ? AND lease_expires_at > ?
            AND lease_confirmed_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM members requester
              WHERE requester.session_id = workspace_file_operations.session_id
                AND requester.id = workspace_file_operations.requested_by_member_id
                AND requester.status = 'approved'
                AND (
                  workspace_file_operations.kind = 'read'
                  OR requester.role = 'owner'
                  OR requester.workspace_file_access = 'workspace-write'
                )
            )
        `)
        .run(
          input.status,
          file?.content ?? null,
          file?.size ?? null,
          file?.modifiedAt ?? null,
          file?.sha256 ?? null,
          errorCode,
          errorMessage,
          completedAt,
          operationId,
          sessionId,
          host.generation,
          input.leaseId,
          completedAt,
        );
      if (updated.changes !== 1) {
        throw new ProtocolError(
          409,
          "workspace_operation_not_processing",
          "The file operation is no longer claimed by the host",
        );
      }
      if (file) {
        this.db
          .prepare(`
            INSERT INTO workspace_files
              (session_id, path, size, modified_at, sha256, content)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, path) DO UPDATE SET
              size = excluded.size,
              modified_at = excluded.modified_at,
              sha256 = excluded.sha256,
              content = excluded.content
          `)
          .run(
            sessionId,
            file.path,
            file.size,
            file.modifiedAt,
            file.sha256,
            file.content,
          );
      }
      this.enforceWorkspaceFileOperationRetention(sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.workspaceFileOperationById(sessionId, operationId);
  }

}

