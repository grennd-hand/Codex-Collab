import { randomUUID } from "node:crypto";
import {
  type WorkspaceFileContent,
  type WorkspaceFileOperation,
  codexConfigRelativePath,
  containsLikelySecret,
  ProtocolError,
} from "@codex-collab/protocol";
import { WorkspaceHistoryStore } from "./workspace-history-store.js";
import {
  type MemberRow,
  type WorkspaceFileOperationRow,
  type WorkspaceFileRow,
  MAX_ACTIVE_FILE_OPERATIONS_PER_MEMBER,
  MAX_ACTIVE_FILE_OPERATIONS_PER_SESSION,
  MAX_FILE_OPERATION_AUDIT_ROWS_PER_SESSION,
  MAX_FILE_OPERATION_RESULT_CONTENT_BYTES,
  MAX_FILE_OPERATION_RESULT_CONTENT_COUNT,
  MAX_MEMBER_WRITE_BYTES_PER_MINUTE,
  MAX_MEMBER_WRITE_OPERATIONS_PER_MINUTE,
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_FILE_COUNT,
  normalizeWorkspaceOperationPath,
  now,
} from "../storage/session-store-types.js";

export class WorkspaceFileOperationStore extends WorkspaceHistoryStore {
  getWorkspaceFile(
    sessionId: string,
    memberToken: string,
    path: string,
  ): WorkspaceFileContent {
    this.requireBrowserMember(sessionId, memberToken, true);
    const row = this.db
      .prepare(`
        SELECT path, size, modified_at, sha256, content
        FROM workspace_files WHERE session_id = ? AND path = ?
      `)
      .get(sessionId, path) as WorkspaceFileRow | undefined;
    if (!row) {
      throw new ProtocolError(404, "workspace_file_not_found", "Shared file was not found");
    }
    return { ...this.toWorkspaceFile(row), content: row.content };
  }

  createWorkspaceFileOperation(
    sessionId: string,
    memberToken: string,
    input:
      | { kind: "read"; path: string }
      | { kind: "write"; path: string; content: string; expectedSha256: string },
  ): WorkspaceFileOperation {
    const member = this.requireBrowserMember(sessionId, memberToken, true);
    const state = this.workspaceState(sessionId);
    if (!state?.host_generation || !state.host_token_id) {
      throw new ProtocolError(409, "host_not_paired", "Pair the local Codex host first");
    }
    if (!state.selected_thread_id) {
      throw new ProtocolError(
        409,
        "workspace_thread_not_selected",
        "Select a Codex task before opening or editing workspace files",
      );
    }
    const path = normalizeWorkspaceOperationPath(input.path);
    if (codexConfigRelativePath(path) && input.kind !== "read") {
      throw new ProtocolError(
        403,
        "workspace_file_not_shared",
        "Codex configuration is read-only in the collaboration editor",
      );
    }
    if (input.kind === "write") {
      this.requireRoomOpen(sessionId);
      if (member.role !== "owner" && member.workspaceFileAccess !== "workspace-write") {
        throw new ProtocolError(
          403,
          "workspace_read_only",
          "The owner has not granted this member workspace write access",
        );
      }
      const contentBytes = Buffer.byteLength(input.content);
      if (contentBytes > 2_000_000) {
        throw new ProtocolError(
          413,
          "workspace_file_too_large",
          "File exceeds the 2 MB collaboration write limit",
        );
      }
      if (input.content.includes("\0")) {
        throw new ProtocolError(
          400,
          "workspace_binary_file_unsupported",
          "The web editor supports text files only",
        );
      }
      if (containsLikelySecret(input.content)) {
        throw new ProtocolError(
          403,
          "workspace_file_not_shared",
          "This file is not available to the collaboration editor",
        );
      }
      if (!/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
        throw new ProtocolError(
          400,
          "invalid_expected_sha256",
          "expectedSha256 must be the observed SHA-256 hash of an existing shared file",
        );
      }
      const existing = this.db
        .prepare("SELECT 1 AS present FROM workspace_files WHERE session_id = ? AND path = ?")
        .get(sessionId, path) as { present: number } | undefined;
      if (!existing) {
        throw new ProtocolError(
          404,
          "workspace_file_not_found",
          "Only files already present in the shared workspace can be edited",
        );
      }
    }

    const operationId = randomUUID();
    const requestedAt = now();
    if (input.kind === "write") {
      this.assertWorkspaceWriteAdmission(
        sessionId,
        member.id,
        path,
        Buffer.byteLength(input.content),
        requestedAt,
      );
    }
    const activeForMember = this.db
      .prepare(`
        SELECT COUNT(*) AS count FROM workspace_file_operations
        WHERE session_id = ? AND requested_by_member_id = ?
          AND status IN ('queued', 'processing')
      `)
      .get(sessionId, member.id) as { count: number };
    const activeForSession = this.db
      .prepare(`
        SELECT COUNT(*) AS count FROM workspace_file_operations
        WHERE session_id = ? AND status IN ('queued', 'processing')
      `)
      .get(sessionId) as { count: number };
    if (
      activeForMember.count >= MAX_ACTIVE_FILE_OPERATIONS_PER_MEMBER ||
      activeForSession.count >= MAX_ACTIVE_FILE_OPERATIONS_PER_SESSION
    ) {
      throw new ProtocolError(
        429,
        "workspace_operation_limit",
        "Wait for existing workspace file operations to finish",
      );
    }
    this.db
      .prepare(`
        INSERT INTO workspace_file_operations
          (id, session_id, requested_by_member_id, requested_by_display_name,
           host_generation, kind, path, request_content, request_size,
           expected_sha256, status, requested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `)
      .run(
        operationId,
        sessionId,
        member.id,
        member.displayName,
        state.host_generation,
        input.kind,
        path,
        input.kind === "write" ? input.content : null,
        input.kind === "write" ? Buffer.byteLength(input.content) : null,
        input.kind === "write" ? input.expectedSha256 : null,
        requestedAt,
      );
    return this.workspaceFileOperationById(sessionId, operationId);
  }

  listWorkspaceFileOperations(
    sessionId: string,
    memberToken: string,
    limit = 100,
  ): WorkspaceFileOperation[] {
    const member = this.requireBrowserMember(sessionId, memberToken, true);
    const rows = (member.role === "owner"
      ? this.db
          .prepare(`
            SELECT * FROM workspace_file_operations
            WHERE session_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?
          `)
          .all(sessionId, limit)
      : this.db
          .prepare(`
            SELECT * FROM workspace_file_operations
            WHERE session_id = ? AND requested_by_member_id = ?
            ORDER BY requested_at DESC, id DESC LIMIT ?
          `)
          .all(sessionId, member.id, limit)) as unknown as WorkspaceFileOperationRow[];
    return rows.map((row) => this.toWorkspaceFileOperation(row, false));
  }

  getWorkspaceFileOperation(
    sessionId: string,
    memberToken: string,
    operationId: string,
  ): WorkspaceFileOperation {
    const member = this.requireBrowserMember(sessionId, memberToken, true);
    const operation = this.workspaceFileOperationById(sessionId, operationId);
    if (
      member.role !== "owner" &&
      operation.requestedByMemberId !== member.id
    ) {
      throw new ProtocolError(
        403,
        "workspace_operation_private",
        "Only the requester or owner can read this file operation",
      );
    }
    return operation;
  }


  protected workspaceFileOperationRowById(
    sessionId: string,
    operationId: string,
  ): WorkspaceFileOperationRow {
    const row = this.db
      .prepare(`
        SELECT * FROM workspace_file_operations
        WHERE session_id = ? AND id = ?
      `)
      .get(sessionId, operationId) as WorkspaceFileOperationRow | undefined;
    if (!row) {
      throw new ProtocolError(
        404,
        "workspace_operation_not_found",
        "Workspace file operation was not found",
      );
    }
    return row;
  }

  protected assertWorkspaceWriteAdmission(
    sessionId: string,
    memberId: string,
    path: string,
    contentBytes: number,
    requestedAt: string,
  ): void {
    const cutoff = new Date(Date.parse(requestedAt) - 60_000).toISOString();
    const recent = this.db
      .prepare(`
        SELECT COUNT(*) AS count,
               COALESCE(SUM(request_size), 0) AS bytes
        FROM workspace_file_operations
        WHERE session_id = ? AND requested_by_member_id = ? AND kind = 'write'
          AND requested_at >= ?
      `)
      .get(sessionId, memberId, cutoff) as { count: number; bytes: number };
    if (
      recent.count >= MAX_MEMBER_WRITE_OPERATIONS_PER_MINUTE ||
      recent.bytes + contentBytes > MAX_MEMBER_WRITE_BYTES_PER_MINUTE
    ) {
      throw new ProtocolError(
        429,
        "workspace_write_rate_limit",
        "Wait before sending more workspace file changes",
      );
    }

    const projected = new Map(
      (
        this.db
          .prepare("SELECT path, size FROM workspace_files WHERE session_id = ?")
          .all(sessionId) as unknown as Array<{ path: string; size: number }>
      ).map((file) => [file.path, file.size]),
    );
    const activeWrites = this.db
      .prepare(`
        SELECT path, LENGTH(CAST(request_content AS BLOB)) AS content_bytes
        FROM workspace_file_operations
        WHERE session_id = ? AND kind = 'write'
          AND status IN ('queued', 'processing') AND request_content IS NOT NULL
      `)
      .all(sessionId) as unknown as Array<{ path: string; content_bytes: number }>;
    for (const active of activeWrites) projected.set(active.path, active.content_bytes);
    projected.set(path, contentBytes);
    const projectedBytes = [...projected.values()].reduce((total, size) => total + size, 0);
    if (
      projected.size > MAX_WORKSPACE_FILE_COUNT ||
      projectedBytes > MAX_WORKSPACE_FILE_BYTES
    ) {
      throw new ProtocolError(
        413,
        "workspace_capacity_exceeded",
        "The shared workspace has reached its file storage limit",
      );
    }
  }

  protected workspaceOperationPermissionError(
    row: WorkspaceFileOperationRow,
  ): { code: string; message: string } | null {
    const requester = this.db
      .prepare(`
        SELECT status, role, workspace_file_access
        FROM members WHERE session_id = ? AND id = ?
      `)
      .get(row.session_id, row.requested_by_member_id) as
      | Pick<MemberRow, "status" | "role" | "workspace_file_access">
      | undefined;
    if (requester?.status !== "approved") {
      return {
        code: "member_not_approved",
        message: "The requesting member is no longer approved",
      };
    }
    if (
      row.kind === "write" &&
      requester.role !== "owner" &&
      requester.workspace_file_access !== "workspace-write"
    ) {
      return {
        code: "workspace_read_only",
        message: "Workspace write access was removed before host execution",
      };
    }
    return null;
  }

  protected assertWorkspaceFileCapacity(
    sessionId: string,
    path: string,
    contentBytes: number,
  ): void {
    const current = this.db
      .prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes,
               COALESCE(MAX(CASE WHEN path = ? THEN size END), 0) AS replaced_bytes,
               MAX(CASE WHEN path = ? THEN 1 ELSE 0 END) AS path_exists
        FROM workspace_files WHERE session_id = ?
      `)
      .get(path, path, sessionId) as {
      count: number;
      bytes: number;
      replaced_bytes: number;
      path_exists: number;
    };
    const nextCount = current.count + (current.path_exists ? 0 : 1);
    const nextBytes = current.bytes - current.replaced_bytes + contentBytes;
    if (nextCount > MAX_WORKSPACE_FILE_COUNT || nextBytes > MAX_WORKSPACE_FILE_BYTES) {
      throw new ProtocolError(
        413,
        "workspace_capacity_exceeded",
        "The shared workspace has reached its file storage limit",
      );
    }
  }

  protected enforceWorkspaceFileOperationRetention(sessionId: string): void {
    const rows = this.db
      .prepare(`
        SELECT id, LENGTH(CAST(result_content AS BLOB)) AS content_bytes
        FROM workspace_file_operations
        WHERE session_id = ? AND result_content IS NOT NULL
        ORDER BY completed_at DESC, requested_at DESC, id DESC
      `)
      .all(sessionId) as unknown as Array<{ id: string; content_bytes: number }>;
    let retainedCount = 0;
    let retainedBytes = 0;
    const clearResult = this.db.prepare(`
      UPDATE workspace_file_operations SET result_content = NULL WHERE id = ?
    `);
    for (const row of rows) {
      const nextCount = retainedCount + 1;
      const nextBytes = retainedBytes + row.content_bytes;
      if (
        nextCount > MAX_FILE_OPERATION_RESULT_CONTENT_COUNT ||
        nextBytes > MAX_FILE_OPERATION_RESULT_CONTENT_BYTES
      ) {
        clearResult.run(row.id);
        continue;
      }
      retainedCount = nextCount;
      retainedBytes = nextBytes;
    }
    this.db
      .prepare(`
        DELETE FROM workspace_file_operations
        WHERE id IN (
          SELECT id FROM workspace_file_operations
          WHERE session_id = ? AND status IN ('completed', 'failed')
          ORDER BY completed_at DESC, requested_at DESC, id DESC
          LIMIT -1 OFFSET ?
        )
      `)
      .run(sessionId, MAX_FILE_OPERATION_AUDIT_ROWS_PER_SESSION);
  }

  protected workspaceFileOperationById(
    sessionId: string,
    operationId: string,
  ): WorkspaceFileOperation {
    return this.toWorkspaceFileOperation(
      this.workspaceFileOperationRowById(sessionId, operationId),
    );
  }

  protected toWorkspaceFileOperation(
    row: WorkspaceFileOperationRow,
    includeResultContent = true,
  ): WorkspaceFileOperation {
    const resultFileMetadata =
      row.result_size !== null &&
      row.result_modified_at !== null &&
      row.result_sha256 !== null
        ? {
            path: row.path,
            size: row.result_size,
            modifiedAt: row.result_modified_at,
            sha256: row.result_sha256,
          }
        : null;
    const resultFile =
      includeResultContent && row.result_content !== null && resultFileMetadata
        ? { ...resultFileMetadata, content: row.result_content }
        : null;
    return {
      id: row.id,
      sessionId: row.session_id,
      requestedByMemberId: row.requested_by_member_id,
      requestedByDisplayName: row.requested_by_display_name,
      hostGeneration: row.host_generation ?? "",
      kind: row.kind,
      path: row.path,
      expectedSha256: row.expected_sha256,
      status: row.status,
      resultFileMetadata,
      resultFile,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      requestedAt: row.requested_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

}

