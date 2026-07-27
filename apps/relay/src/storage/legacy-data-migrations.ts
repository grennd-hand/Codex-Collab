import { DatabaseSync } from "node:sqlite";
import { now } from "./session-store-types.js";

export function backfillInFlightMessageThreadIds(db: DatabaseSync): void {
    const migratedAt = now();
    db.exec(`
      UPDATE messages
      SET selected_thread_id = (
        SELECT workspace_state.selected_thread_id
        FROM workspace_state
        WHERE workspace_state.session_id = messages.session_id
      )
      WHERE selected_thread_id IS NULL
        AND kind IN ('codex_prompt', 'codex_stop')
        AND delivery_status IN ('queued', 'submitted')
        AND EXISTS (
          SELECT 1 FROM workspace_state
          WHERE workspace_state.session_id = messages.session_id
            AND workspace_state.selected_thread_id IS NOT NULL
        )
    `);
    db
      .prepare(`
        UPDATE messages
        SET delivery_status = 'failed',
            codex_turn_id = 'migration:no-selected-workspace-task',
            completed_at = ?
        WHERE selected_thread_id IS NULL
          AND kind IN ('codex_prompt', 'codex_stop')
          AND delivery_status IN ('queued', 'submitted')
      `)
      .run(migratedAt);
  }

export function disconnectUnboundLegacyHosts(db: DatabaseSync): void {
    const disconnectedAt = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db
        .prepare(`
          UPDATE workspace_file_operations
          SET status = 'failed', request_content = NULL, result_content = NULL,
              lease_id = NULL, lease_expires_at = NULL, lease_confirmed_at = NULL,
              error_code = 'host_repair_required',
              error_message = 'Pair the Codex host again after upgrading',
              completed_at = COALESCE(completed_at, ?)
          WHERE status IN ('queued', 'processing')
            AND session_id IN (
              SELECT session_id FROM workspace_state
              WHERE host_token_id IS NULL OR host_generation IS NULL
            )
        `)
        .run(disconnectedAt);
      db
        .prepare(`
          UPDATE host_pairings SET used_at = ?
          WHERE used_at IS NULL AND session_id IN (
            SELECT session_id FROM workspace_state
            WHERE host_token_id IS NULL OR host_generation IS NULL
          )
        `)
        .run(disconnectedAt);
      db.exec(`
        DELETE FROM workspace_files
        WHERE session_id IN (
          SELECT session_id FROM workspace_state
          WHERE host_token_id IS NULL OR host_generation IS NULL
        );
        UPDATE workspace_state
        SET catalog_json = '[]', selected_thread_id = NULL, history_json = '[]',
            history_count = 0,
            codex_runtime_status = 'unavailable', synced_at = NULL
        WHERE host_token_id IS NULL OR host_generation IS NULL;
      `);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }



