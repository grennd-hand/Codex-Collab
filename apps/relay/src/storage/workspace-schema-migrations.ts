import { DatabaseSync } from "node:sqlite";

export function migrateWorkspaceOperationKinds(db: DatabaseSync): void {
  const schema = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_file_operations'",
    )
    .get() as { sql?: string } | undefined;
  if (schema?.sql?.includes("'mkdir'")) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP INDEX IF EXISTS workspace_file_operations_queue_idx;
      DROP INDEX IF EXISTS workspace_file_operations_actor_idx;
      ALTER TABLE workspace_file_operations RENAME TO workspace_file_operations_legacy;
      CREATE TABLE workspace_file_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        requested_by_member_id TEXT NOT NULL REFERENCES members(id),
        requested_by_display_name TEXT NOT NULL,
        host_generation TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('read', 'write', 'mkdir')),
        path TEXT NOT NULL,
        request_content TEXT,
        request_size INTEGER,
        expected_sha256 TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
        result_content TEXT,
        result_size INTEGER,
        result_modified_at TEXT,
        result_sha256 TEXT,
        error_code TEXT,
        error_message TEXT,
        requested_at TEXT NOT NULL,
        started_at TEXT,
        lease_id TEXT,
        lease_expires_at TEXT,
        lease_confirmed_at TEXT,
        completed_at TEXT
      );
      INSERT INTO workspace_file_operations (
        id, session_id, requested_by_member_id, requested_by_display_name,
        host_generation, kind, path, request_content, request_size,
        expected_sha256, status, result_content, result_size, result_modified_at,
        result_sha256, error_code, error_message, requested_at, started_at,
        lease_id, lease_expires_at, lease_confirmed_at, completed_at
      )
      SELECT
        id, session_id, requested_by_member_id, requested_by_display_name,
        host_generation, kind, path, request_content, request_size,
        expected_sha256, status, result_content, result_size, result_modified_at,
        result_sha256, error_code, error_message, requested_at, started_at,
        lease_id, lease_expires_at, lease_confirmed_at, completed_at
      FROM workspace_file_operations_legacy;
      DROP TABLE workspace_file_operations_legacy;
      CREATE INDEX workspace_file_operations_queue_idx
        ON workspace_file_operations(session_id, status, requested_at);
      CREATE INDEX workspace_file_operations_actor_idx
        ON workspace_file_operations(session_id, requested_by_member_id, requested_at);
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
