import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore, selectIdeThread } from "../testing/session-store-test-support.js";

describe("SessionStore workspace limits", () => {
  it("caps active operations and retains bounded result bodies and audit rows", () => {
    const store = createStore();
    const created = store.createSession("Bounded IDE room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    for (let index = 0; index < 8; index += 1) {
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "read",
        path: `src/queued-${index}.ts`,
      });
    }
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "read",
        path: "src/queued-overflow.ts",
      }),
    ).toThrowError(/wait for existing/i);
    store.db
      .prepare(
        "UPDATE workspace_file_operations SET status = 'failed', completed_at = ?, error_code = 'test', error_message = 'test' WHERE status = 'queued'",
      )
      .run("2026-07-27T00:00:00.000Z");

    const completedIds: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const queued = store.createWorkspaceFileOperation(
        created.session.id,
        created.memberToken,
        { kind: "read", path: `src/result-${index}.ts` },
      );
      const claim = store.claimNextWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
      ).operation!;
      store.confirmWorkspaceFileOperationLease(
        created.session.id,
        host.memberToken,
        queued.id,
        claim.leaseId,
      );
      const content = `export const value${index} = ${index};`;
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        queued.id,
        {
          status: "completed",
          leaseId: claim.leaseId,
          file: {
            path: queued.path,
            content,
            size: Buffer.byteLength(content),
            modifiedAt: new Date(Date.UTC(2026, 6, 27, 0, 0, index)).toISOString(),
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        },
      );
      completedIds.push(queued.id);
    }
    expect(
      store.listWorkspaceFileOperations(created.session.id, created.memberToken, 100)
        .filter((operation) => completedIds.includes(operation.id))
        .every((operation) => operation.resultFile === null),
    ).toBe(true);
    const cleared = store.db
      .prepare(`
        SELECT id FROM workspace_file_operations
        WHERE id IN (${completedIds.map(() => "?").join(",")})
          AND result_content IS NULL AND result_sha256 IS NOT NULL
        LIMIT 1
      `)
      .get(...completedIds) as { id: string };
    expect(
      store.getWorkspaceFileOperation(created.session.id, created.memberToken, cleared.id),
    ).toMatchObject({ resultFile: null, resultFileMetadata: { path: expect.any(String) } });
    expect(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_file_operations WHERE result_content IS NOT NULL",
        )
        .get(),
    ).toEqual({ count: 20 });

    const generation = (
      store.db
        .prepare("SELECT host_generation FROM workspace_state WHERE session_id = ?")
        .get(created.session.id) as { host_generation: string }
    ).host_generation;
    const insertTerminal = store.db.prepare(`
      INSERT INTO workspace_file_operations
        (id, session_id, requested_by_member_id, requested_by_display_name,
         host_generation, kind, path, status, requested_at, completed_at)
      VALUES (?, ?, ?, 'Owner', ?, 'read', ?, 'failed', ?, ?)
    `);
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 480; index += 1) {
        const timestamp = new Date(Date.UTC(2026, 6, 26, 0, 0, index)).toISOString();
        insertTerminal.run(
          `seed-terminal-${index}`,
          created.session.id,
          created.session.ownerMemberId,
          generation,
          `src/seed-${index}.ts`,
          timestamp,
          timestamp,
        );
      }
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    const trigger = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "read", path: "src/trigger.ts" },
    );
    const triggerClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      trigger.id,
      triggerClaim.leaseId,
    );
    const triggerContent = "export const trigger = true;";
    store.completeWorkspaceFileOperation(created.session.id, host.memberToken, trigger.id, {
      status: "completed",
      leaseId: triggerClaim.leaseId,
      file: {
        path: trigger.path,
        content: triggerContent,
        size: Buffer.byteLength(triggerContent),
        modifiedAt: "2026-07-27T01:00:00.000Z",
        sha256: createHash("sha256").update(triggerContent).digest("hex"),
      },
    });
    expect(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_file_operations WHERE session_id = ? AND status IN ('completed', 'failed')",
        )
        .get(created.session.id),
    ).toEqual({ count: 500 });
  });

  it("enforces workspace file count and byte caps without double-counting updates", () => {
    const store = createStore();
    const created = store.createSession("Capacity room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const insertFile = store.db.prepare(`
      INSERT INTO workspace_files (session_id, path, size, modified_at, sha256, content)
      VALUES (?, ?, ?, '2026-07-27T00:00:00.000Z', ?, ?)
    `);
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 600; index += 1) {
        insertFile.run(
          created.session.id,
          `src/existing-${index}.ts`,
          0,
          "a".repeat(64),
          "",
        );
      }
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "write",
        path: "src/new-file.ts",
        content: "x",
        expectedSha256: "",
      }),
    ).toThrowError(/capacity|limit/i);

    const update = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      {
        kind: "write",
        path: "src/existing-0.ts",
        content: "x",
        expectedSha256: "a".repeat(64),
      },
    );
    const updateClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      update.id,
      updateClaim.leaseId,
    );
    expect(
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        update.id,
        {
          status: "completed",
          leaseId: updateClaim.leaseId,
          file: {
            path: update.path,
            content: "x",
            size: 1,
            modifiedAt: "2026-07-27T00:00:01.000Z",
            sha256: createHash("sha256").update("x").digest("hex"),
          },
        },
      ).status,
    ).toBe("completed");
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM workspace_files WHERE session_id = ?")
        .get(created.session.id),
    ).toEqual({ count: 600 });

    store.db
      .prepare("DELETE FROM workspace_files WHERE session_id = ? AND path = ?")
      .run(created.session.id, "src/existing-599.ts");
    const raced = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      {
        kind: "write",
        path: "src/existing-598.ts",
        content: "raced",
        expectedSha256: "a".repeat(64),
      },
    );
    const racedClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      raced.id,
      racedClaim.leaseId,
    );
    insertFile.run(created.session.id, "src/race-a.ts", 0, "c".repeat(64), "");
    insertFile.run(created.session.id, "src/race-b.ts", 0, "d".repeat(64), "");
    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        raced.id,
        {
          status: "completed",
          leaseId: racedClaim.leaseId,
          file: {
            path: raced.path,
            content: "raced",
            size: 5,
            modifiedAt: "2026-07-27T00:00:02.000Z",
            sha256: createHash("sha256").update("raced").digest("hex"),
          },
        },
      ),
    ).toThrowError(/storage limit/i);

    store.db.prepare("DELETE FROM workspace_files WHERE session_id = ?").run(created.session.id);
    store.db
      .prepare(
        "UPDATE workspace_file_operations SET status = 'failed', request_content = NULL, lease_id = NULL, lease_expires_at = NULL, completed_at = ? WHERE status IN ('queued', 'processing')",
      )
      .run("2026-07-27T00:00:03.000Z");
    insertFile.run(
      created.session.id,
      "src/large.ts",
      5_000_000,
      "b".repeat(64),
      "",
    );
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "write",
        path: "src/another.ts",
        content: "y",
        expectedSha256: "",
      }),
    ).toThrowError(/storage limit|capacity/i);
    expect(
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "write",
        path: "src/large.ts",
        content: "smaller",
        expectedSha256: "b".repeat(64),
      }).status,
    ).toBe("queued");
  });

});
