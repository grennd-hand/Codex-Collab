import {
  type WorkspaceFileContent,
  type WorkspaceFileOperation,
  containsLikelySecret,
  ProtocolError,
} from "@codex-collab/protocol";
import { WorkspaceOperationLeaseStore } from "./workspace-operation-lease-store.js";
import {
  type WorkspaceFileOperationRow,
  contentSha256,
  normalizeWorkspaceOperationPath,
  now,
} from "../storage/session-store-types.js";

type WorkspaceOperationCompletionInput =
  | { status: "completed"; leaseId: string; file?: WorkspaceFileContent }
  | {
      status: "failed";
      leaseId: string;
      errorCode: string;
      errorMessage: string;
      file?: WorkspaceFileContent | null;
    };

interface WorkspaceOperationCompletionResult {
  file: WorkspaceFileContent | null;
  errorCode: string | null;
  errorMessage: string | null;
}

function validateCompletionResult(
  row: WorkspaceFileOperationRow,
  input: WorkspaceOperationCompletionInput,
): WorkspaceOperationCompletionResult {
  const file = input.file ?? null;
  const directoryResult =
    row.kind === "mkdir" || (row.kind === "rename" && row.expected_sha256 === null);
  if (input.status === "completed" && !directoryResult && !file) {
    throw new ProtocolError(
      400,
      "invalid_workspace_operation_result",
      "Completed file operations require a file result",
    );
  }
  if (directoryResult && file) {
    throw new ProtocolError(
      400,
      "invalid_workspace_operation_result",
      "Directory operations do not accept a file result",
    );
  }
  if (file) {
    const normalizedPath = normalizeWorkspaceOperationPath(file.path);
    const resultPath = row.kind === "rename" ? row.destination_path : row.path;
    if (normalizedPath !== resultPath) {
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
  return { file, errorCode, errorMessage };
}

function storedResultMatches(
  row: WorkspaceFileOperationRow,
  input: WorkspaceOperationCompletionInput,
  result: WorkspaceOperationCompletionResult,
): boolean {
  const fileMatches = result.file
    ? row.result_content === result.file.content &&
      row.result_size === result.file.size &&
      row.result_modified_at === result.file.modifiedAt &&
      row.result_sha256 === result.file.sha256
    : row.result_content === null &&
      row.result_size === null &&
      row.result_modified_at === null &&
      row.result_sha256 === null;
  return (
    row.status === input.status &&
    fileMatches &&
    row.error_code === result.errorCode &&
    row.error_message === result.errorMessage
  );
}

export class WorkspaceOperationCompletionStore extends WorkspaceOperationLeaseStore {
  completeWorkspaceFileOperation(
    sessionId: string,
    memberToken: string,
    operationId: string,
    input: WorkspaceOperationCompletionInput,
  ): WorkspaceFileOperation {
    this.db.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    try {
      const host = this.requireCurrentHost(sessionId, memberToken);
      const row = this.workspaceFileOperationRowById(sessionId, operationId);
      if (row.host_generation !== host.generation) {
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
      const result = validateCompletionResult(row, input);
      if (row.status === "completed" || row.status === "failed") {
        if (
          row.lease_id === input.leaseId &&
          row.lease_confirmed_at &&
          storedResultMatches(row, input, result)
        ) {
          const operation = this.toWorkspaceFileOperation(row);
          this.db.exec("COMMIT");
          transactionOpen = false;
          return operation;
        }
        throw new ProtocolError(
          409,
          "workspace_operation_not_processing",
          "The file operation already reached a terminal state with a different receipt",
        );
      }
      if (
        row.status !== "processing" ||
        row.lease_id !== input.leaseId ||
        !row.lease_expires_at ||
        !row.lease_confirmed_at
      ) {
        throw new ProtocolError(
          409,
          "workspace_operation_not_processing",
          "The file operation is not currently claimed by the host",
        );
      }
      const { file, errorCode, errorMessage } = result;
      const completedAt = now();
      if (file) {
        this.assertWorkspaceFileCapacity(
          sessionId,
          row.kind === "rename" ? row.destination_path ?? row.path : row.path,
          file.size,
        );
      }
      const updated = this.db
        .prepare(`
          UPDATE workspace_file_operations
          SET status = ?, request_content = NULL,
              result_content = ?, result_size = ?, result_modified_at = ?, result_sha256 = ?,
              error_code = ?, error_message = ?, completed_at = ?
          WHERE id = ? AND session_id = ? AND host_generation = ?
            AND status = 'processing' AND lease_id = ?
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
        if (row.kind === "rename") {
          this.db
            .prepare("DELETE FROM workspace_files WHERE session_id = ? AND path = ?")
            .run(sessionId, row.path);
        }
      }
      if (input.status === "completed" && row.kind === "mkdir") {
        this.db
          .prepare(`
            INSERT INTO workspace_directories (session_id, path)
            VALUES (?, ?) ON CONFLICT(session_id, path) DO NOTHING
          `)
          .run(sessionId, row.path);
      }
      if (
        input.status === "completed" &&
        row.kind === "rename" &&
        row.expected_sha256 === null &&
        row.destination_path
      ) {
        for (const table of ["workspace_directories", "workspace_files"]) {
          this.db.prepare(`
            UPDATE ${table}
            SET path = ? || substr(path, length(?) + 1)
            WHERE session_id = ?
              AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
          `).run(
            row.destination_path,
            row.path,
            sessionId,
            row.path,
            row.path,
            row.path,
          );
        }
      }
      this.enforceWorkspaceFileOperationRetention(sessionId);
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
