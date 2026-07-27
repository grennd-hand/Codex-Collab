import { ProtocolError } from "@codex-collab/protocol";
import { MAX_WORKSPACE_DIRECTORY_COUNT } from "../storage/session-store-types.js";
import { WorkspaceHistoryStore } from "./workspace-history-store.js";

export class WorkspaceEntryAdmissionStore extends WorkspaceHistoryStore {
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
