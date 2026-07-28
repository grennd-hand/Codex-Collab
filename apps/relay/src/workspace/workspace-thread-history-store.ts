import type { CodexRecordEntry } from "@codex-collab/protocol";
import { WorkspaceDirectoryStore } from "./workspace-directory-store.js";

interface WorkspaceThreadHistoryRow {
  history_json: string;
  history_count: number;
  synced_at: string;
}

export class WorkspaceThreadHistoryStore extends WorkspaceDirectoryStore {
  protected cachedWorkspaceThreadIds(sessionId: string): string[] {
    return (
      this.db
        .prepare(`
          SELECT thread_id FROM workspace_thread_histories
          WHERE session_id = ? ORDER BY synced_at DESC
        `)
        .all(sessionId) as unknown as Array<{ thread_id: string }>
    ).map((row) => row.thread_id);
  }

  protected workspaceThreadHistory(
    sessionId: string,
    threadId: string,
  ): WorkspaceThreadHistoryRow | null {
    return (
      (this.db
        .prepare(`
          SELECT history_json, history_count, synced_at
          FROM workspace_thread_histories
          WHERE session_id = ? AND thread_id = ?
        `)
        .get(sessionId, threadId) as WorkspaceThreadHistoryRow | undefined) ?? null
    );
  }

  protected upsertWorkspaceThreadHistory(
    sessionId: string,
    threadId: string,
    history: CodexRecordEntry[],
    syncedAt: string,
  ): void {
    this.db
      .prepare(`
        INSERT INTO workspace_thread_histories
          (session_id, thread_id, history_json, history_count, synced_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, thread_id) DO UPDATE SET
          history_json = excluded.history_json,
          history_count = excluded.history_count,
          synced_at = excluded.synced_at
      `)
      .run(sessionId, threadId, JSON.stringify(history), history.length, syncedAt);
  }

  protected clearWorkspaceThreadHistories(sessionId: string): void {
    this.db
      .prepare("DELETE FROM workspace_thread_histories WHERE session_id = ?")
      .run(sessionId);
  }
}
