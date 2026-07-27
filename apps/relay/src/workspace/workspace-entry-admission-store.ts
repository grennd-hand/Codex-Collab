import { ProtocolError } from "@codex-collab/protocol";
import {
  MAX_WORKSPACE_DIRECTORY_COUNT,
  normalizeWorkspaceDirectoryPath,
  normalizeWorkspaceOperationPath,
} from "../storage/session-store-types.js";
import { WorkspaceHistoryStore } from "./workspace-history-store.js";

export class WorkspaceEntryAdmissionStore extends WorkspaceHistoryStore {
  protected assertWorkspaceRenameAdmission(
    sessionId: string,
    source: string,
    destination: string,
    expectedSha256: string | null,
  ): { path: string; destinationPath: string; expectedSha256: string | null } {
    const sourceCandidate = normalizeWorkspaceDirectoryPath(source);
    const file = this.db
      .prepare("SELECT sha256 FROM workspace_files WHERE session_id = ? AND path = ?")
      .get(sessionId, sourceCandidate) as { sha256: string } | undefined;
    const directory = this.db
      .prepare("SELECT 1 AS present FROM workspace_directories WHERE session_id = ? AND path = ?")
      .get(sessionId, sourceCandidate) as { present: number } | undefined;
    if (!file && !directory) {
      throw new ProtocolError(404, "workspace_file_not_found", "The entry is no longer present");
    }
    const path = file ? normalizeWorkspaceOperationPath(source) : sourceCandidate;
    const destinationPath = file
      ? normalizeWorkspaceOperationPath(destination)
      : normalizeWorkspaceDirectoryPath(destination);
    const parent = (value: string) => value.slice(0, Math.max(0, value.lastIndexOf("/")));
    if (path === destinationPath || parent(path) !== parent(destinationPath)) {
      throw new ProtocolError(400, "invalid_rename", "Rename must keep the entry in its current folder");
    }
    if (file && expectedSha256 !== file.sha256) {
      throw new ProtocolError(409, "file_conflict", "The file changed before it could be renamed");
    }
    if (directory && expectedSha256 !== null) {
      throw new ProtocolError(400, "invalid_expected_sha256", "Directory rename does not accept a file hash");
    }
    const occupied = this.db.prepare(`
      SELECT 1 AS present FROM workspace_files
      WHERE session_id = ? AND (path = ? OR (? = 1 AND substr(path, 1, length(?) + 1) = ? || '/'))
      UNION ALL
      SELECT 1 AS present FROM workspace_directories
      WHERE session_id = ? AND (path = ? OR (? = 1 AND substr(path, 1, length(?) + 1) = ? || '/'))
      UNION ALL
      SELECT 1 AS present FROM workspace_file_operations
      WHERE session_id = ? AND destination_path = ? AND status IN ('queued', 'processing')
      LIMIT 1
    `).get(
      sessionId, destinationPath, directory ? 1 : 0, destinationPath, destinationPath,
      sessionId, destinationPath, directory ? 1 : 0, destinationPath, destinationPath,
      sessionId, destinationPath,
    ) as { present: number } | undefined;
    if (occupied) {
      throw new ProtocolError(409, "file_conflict", "The destination path already exists");
    }
    return { path, destinationPath, expectedSha256: file?.sha256 ?? null };
  }

  protected assertWorkspaceDirectoryAdmission(
    sessionId: string,
    path: string,
  ): void {
    const conflict = this.db
      .prepare(`
        SELECT 1 AS present FROM workspace_directories
        WHERE session_id = ? AND path = ?
        UNION ALL
        SELECT 1 AS present FROM workspace_files
        WHERE session_id = ? AND path = ?
        UNION ALL
        SELECT 1 AS present FROM workspace_file_operations
        WHERE session_id = ? AND kind = 'mkdir' AND path = ?
          AND status IN ('queued', 'processing')
        LIMIT 1
      `)
      .get(sessionId, path, sessionId, path, sessionId, path) as
      | { present: number }
      | undefined;
    if (conflict) {
      throw new ProtocolError(
        409,
        "file_conflict",
        "A file or directory already exists at the requested path",
      );
    }
    const directoryCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM workspace_directories WHERE session_id = ?")
      .get(sessionId) as { count: number };
    if (directoryCount.count >= MAX_WORKSPACE_DIRECTORY_COUNT) {
      throw new ProtocolError(
        413,
        "workspace_capacity_exceeded",
        "The shared workspace directory limit has been reached",
      );
    }
  }
}
