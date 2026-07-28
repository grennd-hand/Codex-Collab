import { describe, expect, it } from "vitest";
import { ProtocolError } from "@codex-collab/protocol";
import { createStore, selectIdeThread } from "./session-store-test-support.js";

function createHostRoom() {
  const store = createStore();
  const created = store.createSession("Lease release room", "Owner");
  const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
  const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
  selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
  return { store, created, host };
}

function expectProtocolCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
  }
}

describe("SessionStore workspace file operation lease release", () => {
  it("keeps FIFO blocked until unconfirmed or confirmed work is explicitly released", () => {
    const { store, created, host } = createHostRoom();
    const first = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "mkdir", path: "first" },
    );
    const second = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "mkdir", path: "second" },
    );

    const firstClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    expect(firstClaim.id).toBe(first.id);
    expect(
      store.claimNextWorkspaceFileOperation(created.session.id, host.memberToken).operation,
    ).toBeNull();

    expect(
      store.releaseWorkspaceFileOperationLease(
        created.session.id,
        host.memberToken,
        first.id,
        firstClaim.leaseId,
      ),
    ).toMatchObject({ id: first.id, status: "queued", startedAt: null });
    expect(
      store.db
        .prepare(`
          SELECT lease_id, lease_expires_at, lease_confirmed_at
          FROM workspace_file_operations WHERE id = ?
        `)
        .get(first.id),
    ).toEqual({ lease_id: null, lease_expires_at: null, lease_confirmed_at: null });

    const confirmedClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    expect(confirmedClaim.id).toBe(first.id);
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      first.id,
      confirmedClaim.leaseId,
    );
    expect(
      store.claimNextWorkspaceFileOperation(created.session.id, host.memberToken).operation,
    ).toBeNull();
    store.releaseWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      first.id,
      confirmedClaim.leaseId,
    );

    const finalClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    expect(finalClaim.id).toBe(first.id);
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      first.id,
      finalClaim.leaseId,
    );
    store.completeWorkspaceFileOperation(created.session.id, host.memberToken, first.id, {
      status: "completed",
      leaseId: finalClaim.leaseId,
    });
    expect(
      store.claimNextWorkspaceFileOperation(created.session.id, host.memberToken).operation?.id,
    ).toBe(second.id);
  });

  it("uses an exact lease CAS and rejects repeated, old, and terminal releases", () => {
    const { store, created, host } = createHostRoom();
    const operation = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "mkdir", path: "cas" },
    );
    const firstClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;

    expectProtocolCode(
      () =>
        store.releaseWorkspaceFileOperationLease(
          created.session.id,
          host.memberToken,
          operation.id,
          "wrong-lease",
        ),
      "workspace_operation_not_processing",
    );
    expect(
      store.getWorkspaceFileOperation(created.session.id, created.memberToken, operation.id)
        .status,
    ).toBe("processing");

    store.releaseWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      operation.id,
      firstClaim.leaseId,
    );
    expectProtocolCode(
      () =>
        store.releaseWorkspaceFileOperationLease(
          created.session.id,
          host.memberToken,
          operation.id,
          firstClaim.leaseId,
        ),
      "workspace_operation_not_processing",
    );

    const secondClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    expect(secondClaim.leaseId).not.toBe(firstClaim.leaseId);
    expectProtocolCode(
      () =>
        store.releaseWorkspaceFileOperationLease(
          created.session.id,
          host.memberToken,
          operation.id,
          firstClaim.leaseId,
        ),
      "workspace_operation_not_processing",
    );
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      operation.id,
      secondClaim.leaseId,
    );
    store.completeWorkspaceFileOperation(created.session.id, host.memberToken, operation.id, {
      status: "completed",
      leaseId: secondClaim.leaseId,
    });
    expectProtocolCode(
      () =>
        store.releaseWorkspaceFileOperationLease(
          created.session.id,
          host.memberToken,
          operation.id,
          secondClaim.leaseId,
        ),
      "workspace_operation_not_processing",
    );
  });

  it("does not let release bypass requester permission or host generation checks", () => {
    const { store, created, host } = createHostRoom();
    const invite = store.createInvite(created.session.id, created.memberToken, 10, 1);
    const guest = store.joinInvite(invite.inviteToken, "Editor");
    store.approveMember(created.session.id, created.memberToken, guest.member.id);
    const operation = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      { kind: "mkdir", path: "permission-check" },
    );
    const claim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "read-only",
    );

    store.releaseWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      operation.id,
      claim.leaseId,
    );
    const rejected = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    );
    expect(rejected.operation).toBeNull();
    expect(rejected.rejected).toEqual([
      expect.objectContaining({ id: operation.id, status: "failed", errorCode: "workspace_read_only" }),
    ]);

    const ownerOperation = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "mkdir", path: "generation-check" },
    );
    const ownerClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    const nextPairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const nextHost = store.claimHostPairing(
      nextPairing.pairingToken,
      "Replacement PC",
      "Project",
    );
    expectProtocolCode(
      () =>
        store.releaseWorkspaceFileOperationLease(
          created.session.id,
          host.memberToken,
          ownerOperation.id,
          ownerClaim.leaseId,
        ),
      "unauthorized",
    );
    expectProtocolCode(
      () =>
        store.releaseWorkspaceFileOperationLease(
          created.session.id,
          nextHost.memberToken,
          ownerOperation.id,
          ownerClaim.leaseId,
        ),
      "workspace_operation_not_processing",
    );
  });
});
