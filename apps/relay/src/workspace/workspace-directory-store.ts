import {
  isPublishableWorkspaceDirectoryPath,
  ProtocolError,
} from "@codex-collab/protocol";
import { normalizeWorkspaceDirectoryPath } from "../storage/session-store-types.js";
import { WorkspaceHostStore } from "./workspace-host-store.js";

export class WorkspaceDirectoryStore extends WorkspaceHostStore {
  protected clearWorkspaceDirectories(sessionId: string): void {
    this.db
      .prepare("DELETE FROM workspace_directories WHERE session_id = ?")
      .run(sessionId);
  }

  protected replaceWorkspaceDirectories(
    sessionId: string,
    requestedPaths: readonly string[],
  ): void {
    const paths = new Set<string>();
    for (const path of requestedPaths) {
      const normalized = normalizeWorkspaceDirectoryPath(path);
      if (
        normalized !== path ||
        paths.has(path) ||
        !isPublishableWorkspaceDirectoryPath(path)
      ) {
        throw new ProtocolError(
          400,
          "invalid_workspace_directory",
          "Host workspace directory is not eligible for the shared snapshot",
        );
      }
      paths.add(path);
    }
    this.clearWorkspaceDirectories(sessionId);
    const insert = this.db.prepare(`
      INSERT INTO workspace_directories (session_id, path) VALUES (?, ?)
    `);
    for (const path of paths) insert.run(sessionId, path);
  }

  protected workspaceDirectories(sessionId: string): string[] {
    const rows = this.db
      .prepare(`
        SELECT path FROM workspace_directories
        WHERE session_id = ? ORDER BY path ASC
      `)
      .all(sessionId) as unknown as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }
}
