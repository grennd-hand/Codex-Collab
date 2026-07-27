import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSessionStore } from "./sqlite-migrations.js";

describe("workspace schema migrations", () => {
  it("upgrades legacy read/write operation tables to support mkdir", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE workspace_file_operations (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          requested_by_member_id TEXT NOT NULL,
          requested_by_display_name TEXT NOT NULL,
          host_generation TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('read', 'write')),
          path TEXT NOT NULL,
          request_content TEXT,
          request_size INTEGER,
          expected_sha256 TEXT,
          status TEXT NOT NULL,
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
        )
      `);

      migrateSessionStore(db);

      const schema = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_file_operations'",
        )
        .get() as { sql: string };
      expect(schema.sql).toContain("'mkdir'");
      expect(
        db
          .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'workspace_directories'",
          )
          .get(),
      ).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("backfills approved member write access once without undoing a later revocation", () => {
    const db = new DatabaseSync(":memory:");
    migrateSessionStore(db);
    const createdAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions (id, name, owner_member_id, created_at)
       VALUES ('session', 'Room', 'owner', ?)`,
    ).run(createdAt);
    db.prepare(
      `INSERT INTO members (
        id, session_id, display_name, role, status, workspace_file_access,
        token_hash, created_at
      ) VALUES ('owner', 'session', 'Owner', 'owner', 'approved', 'workspace-write',
        'owner-token', ?),
        ('editor', 'session', 'Editor', 'editor', 'approved', 'workspace-write',
        'editor-token', ?)`,
    ).run(createdAt, createdAt);
    db.prepare(
      "UPDATE members SET workspace_file_access = 'read-only' WHERE id = 'editor'",
    ).run();

    migrateSessionStore(db);

    expect(
      db.prepare("SELECT workspace_file_access AS access FROM members WHERE id = 'editor'")
        .get(),
    ).toMatchObject({ access: "read-only" });
    db.close();
  });
});
