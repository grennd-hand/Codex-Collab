import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore, selectIdeThread } from "../testing/session-store-test-support.js";

function resultFile(path: string, content: string) {
  return {
    path,
    content,
    size: Buffer.byteLength(content),
    modifiedAt: "2026-07-29T00:00:00.000Z",
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function createConfirmedRead(path: string) {
  const store = createStore();
  const created = store.createSession("Completion receipts", "Owner");
  const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
  const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
  selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
  const operation = store.createWorkspaceFileOperation(
    created.session.id,
    created.memberToken,
    { kind: "read", path },
  );
  const claim = store.claimNextWorkspaceFileOperation(
    created.session.id,
    host.memberToken,
  ).operation!;
  store.confirmWorkspaceFileOperationLease(
    created.session.id,
    host.memberToken,
    operation.id,
    claim.leaseId,
  );
  return { store, created, host, operation, claim };
}

describe("SessionStore file operation completion receipts", () => {
  it("returns an identical terminal receipt without rewriting its completion audit", () => {
    const { store, created, host, operation, claim } = createConfirmedRead(
      "src/idempotent.ts",
    );
    const file = resultFile(operation.path, "export const receipt = true;");
    const receipt = { status: "completed" as const, leaseId: claim.leaseId, file };

    store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      operation.id,
      receipt,
    );
    const leaseAudit = store.db
      .prepare(`
        SELECT lease_id, lease_expires_at, lease_confirmed_at
        FROM workspace_file_operations WHERE id = ?
      `)
      .get(operation.id) as {
      lease_id: string | null;
      lease_expires_at: string | null;
      lease_confirmed_at: string | null;
    };
    expect(leaseAudit).toEqual({
      lease_id: claim.leaseId,
      lease_expires_at: claim.leaseExpiresAt,
      lease_confirmed_at: expect.any(String),
    });

    const persistedCompletedAt = "2001-02-03T04:05:06.000Z";
    store.db
      .prepare("UPDATE workspace_file_operations SET completed_at = ? WHERE id = ?")
      .run(persistedCompletedAt, operation.id);
    const replay = store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      operation.id,
      receipt,
    );
    expect(replay).toMatchObject({
      status: "completed",
      completedAt: persistedCompletedAt,
      resultFile: file,
    });
    expect(
      store.db
        .prepare(`
          SELECT lease_id, lease_expires_at, lease_confirmed_at, completed_at
          FROM workspace_file_operations WHERE id = ?
        `)
        .get(operation.id),
    ).toEqual({ ...leaseAudit, completed_at: persistedCompletedAt });

    const changedFile = resultFile(operation.path, "export const receipt = false;");
    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        operation.id,
        { ...receipt, file: changedFile },
      ),
    ).toThrowError(/different receipt/i);
    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        operation.id,
        { ...receipt, leaseId: "different-lease" },
      ),
    ).toThrowError(/different receipt/i);
    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        operation.id,
        {
          status: "failed",
          leaseId: claim.leaseId,
          errorCode: "changed",
          errorMessage: "changed",
        },
      ),
    ).toThrowError(/different receipt/i);
    expect(
      store.db
        .prepare(`
          SELECT status, result_content, completed_at
          FROM workspace_file_operations WHERE id = ?
        `)
        .get(operation.id),
    ).toEqual({
      status: "completed",
      result_content: file.content,
      completed_at: persistedCompletedAt,
    });
  });

  it("accepts a late receipt for the same confirmed lease when no replacement claimed it", () => {
    const { store, created, host, operation, claim } = createConfirmedRead(
      "src/late.ts",
    );
    store.db
      .prepare("UPDATE workspace_file_operations SET lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", operation.id);

    const completed = store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      operation.id,
      {
        status: "completed",
        leaseId: claim.leaseId,
        file: resultFile(operation.path, "export const late = true;"),
      },
    );
    expect(completed.status).toBe("completed");
    expect(
      store.db
        .prepare(`
          SELECT lease_id, lease_confirmed_at
          FROM workspace_file_operations WHERE id = ?
        `)
        .get(operation.id),
    ).toEqual({ lease_id: claim.leaseId, lease_confirmed_at: expect.any(String) });
  });

  it("replays an identical failed receipt without allowing its error to change", () => {
    const { store, created, host, operation, claim } = createConfirmedRead(
      "src/failed.ts",
    );
    const receipt = {
      status: "failed" as const,
      leaseId: claim.leaseId,
      errorCode: "host_read_failed",
      errorMessage: "The host could not read the file",
    };
    const first = store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      operation.id,
      receipt,
    );
    expect(first).toMatchObject({
      status: "failed",
      errorCode: receipt.errorCode,
      errorMessage: receipt.errorMessage,
    });
    const replay = store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      operation.id,
      receipt,
    );
    expect(replay).toEqual(first);
    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        operation.id,
        { ...receipt, errorMessage: "A different failure" },
      ),
    ).toThrowError(/different receipt/i);
    expect(
      store.db
        .prepare(`
          SELECT status, lease_id, lease_confirmed_at
          FROM workspace_file_operations WHERE id = ?
        `)
        .get(operation.id),
    ).toEqual({
      status: "failed",
      lease_id: claim.leaseId,
      lease_confirmed_at: expect.any(String),
    });
  });

  it("rejects a late receipt after a replacement lease has claimed the operation", () => {
    const { store, created, host, operation, claim: firstClaim } = createConfirmedRead(
      "src/reclaimed.ts",
    );
    store.db
      .prepare(`
        UPDATE workspace_file_operations
        SET started_at = ?, lease_expires_at = ? WHERE id = ?
      `)
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", operation.id);
    const secondClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    expect(secondClaim.leaseId).not.toBe(firstClaim.leaseId);
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      operation.id,
      secondClaim.leaseId,
    );
    const file = resultFile(operation.path, "export const claimed = true;");

    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        operation.id,
        { status: "completed", leaseId: firstClaim.leaseId, file },
      ),
    ).toThrowError(/currently claimed/i);
    expect(
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        operation.id,
        { status: "completed", leaseId: secondClaim.leaseId, file },
      ).status,
    ).toBe("completed");
  });

  it("does not let receipt replay bypass permission or host-generation changes", () => {
    const store = createStore();
    const created = store.createSession("Receipt boundaries", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const invite = store.createInvite(created.session.id, created.memberToken, 10, 1);
    const guest = store.joinInvite(invite.inviteToken, "Editor");
    store.approveMember(created.session.id, created.memberToken, guest.member.id);
    const operation = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      { kind: "write", path: "src/boundary.ts", content: "", expectedSha256: "" },
    );
    const claim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      operation.id,
      claim.leaseId,
    );
    const receipt = {
      status: "completed" as const,
      leaseId: claim.leaseId,
      file: resultFile(operation.path, ""),
    };
    store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      operation.id,
      receipt,
    );

    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "read-only",
    );
    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        operation.id,
        receipt,
      ),
    ).toThrowError(/removed before host execution/i);
    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "workspace-write",
    );

    const replacementPairing = store.createHostPairing(
      created.session.id,
      created.memberToken,
      10,
    );
    const replacementHost = store.claimHostPairing(
      replacementPairing.pairingToken,
      "Replacement PC",
      "Project",
    );
    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        replacementHost.memberToken,
        operation.id,
        receipt,
      ),
    ).toThrowError(/currently claimed/i);
    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        operation.id,
        receipt,
      ),
    ).toThrowError(/member token is invalid/i);
  });
});
