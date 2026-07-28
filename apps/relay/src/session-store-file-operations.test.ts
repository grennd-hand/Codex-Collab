import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./session-store.js";
import { createStore, publishIdeFile, selectIdeThread } from "./session-store-test-support.js";

describe("SessionStore file operation leases", () => {
  it("grants approved members auditable workspace write access", () => {
    const store = createStore();
    const created = store.createSession("IDE room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const readContent = "export const oldValue = true;";
    const originalSha256 = publishIdeFile(
      store,
      created.session.id,
      host.memberToken,
      "src/index.ts",
      readContent,
    );
    const invite = store.createInvite(created.session.id, created.memberToken, 60, 1);
    const guest = store.joinInvite(invite.inviteToken, "Editor");
    store.approveMember(created.session.id, created.memberToken, guest.member.id);

    expect(created.owner.workspaceFileAccess).toBe("workspace-write");
    expect(store.getCurrentMember(created.session.id, guest.memberToken).workspaceFileAccess).toBe(
      "workspace-write",
    );

    const read = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      { kind: "read", path: "src/index.ts" },
    );
    expect(read.status).toBe("queued");
    expect(read.resultFile).toBeNull();

    const write = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      {
        kind: "write",
        path: "src/index.ts",
        content: "export {};",
        expectedSha256: originalSha256,
      },
    );
    expect(write.status).toBe("queued");
    expect(write.completedAt).toBeNull();
    store.db
      .prepare("UPDATE workspace_file_operations SET requested_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", read.id);

    const firstClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    );
    expect(firstClaim.operation?.id).toBe(read.id);
    expect(firstClaim.operation).not.toHaveProperty("requestContent");
    expect(firstClaim.operation?.expectedSha256).toBeNull();
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      read.id,
      firstClaim.operation!.leaseId,
    );
    store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      read.id,
      {
        status: "completed",
        leaseId: firstClaim.operation!.leaseId,
        file: {
          path: "src/index.ts",
          content: readContent,
          size: Buffer.byteLength(readContent),
          modifiedAt: "2026-07-27T00:00:00.000Z",
          sha256: createHash("sha256").update(readContent).digest("hex"),
        },
      },
    );
    const secondClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    );
    expect(secondClaim.operation?.id).toBe(write.id);
    expect(secondClaim.operation).not.toHaveProperty("requestContent");
    expect(secondClaim.operation?.expectedSha256).toBeNull();
    const confirmedWrite = store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      write.id,
      secondClaim.operation!.leaseId,
    );
    expect(confirmedWrite.requestContent).toBe("export {};");
    expect(confirmedWrite.expectedSha256).toBe(originalSha256);
    const savedContent = "export {};";
    const completed = store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      write.id,
      {
        status: "completed",
        leaseId: secondClaim.operation!.leaseId,
        file: {
          path: "src/index.ts",
          content: savedContent,
          size: Buffer.byteLength(savedContent),
          modifiedAt: "2026-07-27T00:00:01.000Z",
          sha256: createHash("sha256").update(savedContent).digest("hex"),
        },
      },
    );
    expect(completed.status).toBe("completed");
    expect(completed.resultFile?.content).toBe(savedContent);
    expect(
      store.getWorkspaceFile(created.session.id, guest.memberToken, "src/index.ts").content,
    ).toBe(savedContent);
    expect(
      store.listWorkspaceFileOperations(created.session.id, guest.memberToken),
    ).toHaveLength(2);
  });

  it("rechecks queued write permission and rejects private or unsafe editor paths", () => {
    const store = createStore();
    const created = store.createSession("Secure IDE room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const readmeSha256 = publishIdeFile(
      store,
      created.session.id,
      host.memberToken,
      "README.md",
      "original",
    );
    const invite = store.createInvite(created.session.id, created.memberToken, 60, 1);
    const guest = store.joinInvite(invite.inviteToken, "Editor");
    store.approveMember(created.session.id, created.memberToken, guest.member.id);
    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "workspace-write",
    );
    const queued = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      {
        kind: "write",
        path: "README.md",
        content: "queued",
        expectedSha256: readmeSha256,
      },
    );
    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "read-only",
    );
    const claim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    );
    expect(claim.operation).toBeNull();
    expect(claim.rejected.map((operation) => operation.id)).toContain(queued.id);
    expect(
      store.getWorkspaceFileOperation(created.session.id, guest.memberToken, queued.id),
    ).toMatchObject({ status: "failed", errorCode: "workspace_read_only" });

    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "workspace-write",
    );
    const revokedRead = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      { kind: "read", path: "README.md" },
    );
    store.db
      .prepare("UPDATE members SET status = 'revoked' WHERE session_id = ? AND id = ?")
      .run(created.session.id, guest.member.id);
    const revokedClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    );
    expect(revokedClaim.operation).toBeNull();
    expect(
      store.getWorkspaceFileOperation(
        created.session.id,
        created.memberToken,
        revokedRead.id,
      ),
    ).toMatchObject({ status: "failed", errorCode: "member_not_approved" });

    for (const path of [
      "../outside.txt", "C:\\outside.txt", ".codex/auth.json", ".env",
      ".aws/settings.json", ".azure/profile.json", ".gnupg/options.conf", ".SSH/public.txt",
      "node_modules/package/index.ts",
    ]) {
      expect(() =>
        store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
          kind: "read",
          path,
        }),
      ).toThrow();
    }
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "write",
        path: "src/config.ts",
        content: "ACCESS_TOKEN=custom-super-secret-token-123456",
        expectedSha256: "a".repeat(64),
      }),
    ).toThrowError(/not available/i);

    const secretRead = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "read", path: "src/leak.txt" },
    );
    const secretClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      secretRead.id,
      secretClaim.leaseId,
    );
    const secretContent = "ACCESS_TOKEN=custom-super-secret-token-123456";
    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        secretRead.id,
        {
          status: "completed",
          leaseId: secretClaim.leaseId,
          file: {
            path: secretRead.path,
            content: secretContent,
            size: Buffer.byteLength(secretContent),
            modifiedAt: "2026-07-27T00:00:00.000Z",
            sha256: createHash("sha256").update(secretContent).digest("hex"),
          },
        },
      ),
    ).toThrowError(/not available/i);
    expect(
      store.db
        .prepare("SELECT result_content FROM workspace_file_operations WHERE id = ?")
        .get(secretRead.id),
    ).toEqual({ result_content: null });
  });

  it("creates a new file and an empty directory inside the approved root", () => {
    const store = createStore();
    const created = store.createSession("Create entries", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const invite = store.createInvite(created.session.id, created.memberToken, 60, 1);
    const guest = store.joinInvite(invite.inviteToken, "Editor");
    store.approveMember(created.session.id, created.memberToken, guest.member.id);

    const fileOperation = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      {
        kind: "write",
        path: "src/new-file.ts",
        content: "",
        expectedSha256: "",
      },
    );
    const fileClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    const confirmedFile = store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      fileOperation.id,
      fileClaim.leaseId,
    );
    expect(confirmedFile.expectedSha256).toBe("");
    store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      fileOperation.id,
      {
        status: "completed",
        leaseId: fileClaim.leaseId,
        file: {
          path: "src/new-file.ts",
          content: "",
          size: 0,
          modifiedAt: "2026-07-28T00:00:00.000Z",
          sha256: createHash("sha256").update("").digest("hex"),
        },
      },
    );

    const directoryOperation = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      { kind: "mkdir", path: "src/empty-folder" },
    );
    const directoryClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      directoryOperation.id,
      directoryClaim.leaseId,
    );
    store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      directoryOperation.id,
      { status: "completed", leaseId: directoryClaim.leaseId },
    );

    const workspace = store.getWorkspace(created.session.id, guest.memberToken);
    expect(workspace.files.map((file) => file.path)).toContain("src/new-file.ts");
    expect(workspace.directories).toContain("src/empty-folder");
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, guest.memberToken, {
        kind: "mkdir",
        path: "1",
      }),
    ).not.toThrow();
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, guest.memberToken, {
        kind: "write",
        path: "src/new-file.ts",
        content: "",
        expectedSha256: "",
      }),
    ).toThrowError(/already exists/i);
    store.db
      .prepare("INSERT INTO workspace_directories (session_id, path) VALUES (?, ?)")
      .run(created.session.id, "src/existing.ts");
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, guest.memberToken, {
        kind: "write",
        path: "src/existing.ts",
        content: "",
        expectedSha256: "",
      }),
    ).toThrowError(/already exists/i);
  });

  it("keeps queued file operations durable across relay restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-operation-db-"));
    const filename = join(directory, "relay.sqlite");
    const first = new SessionStore(filename);
    const created = first.createSession("Durable IDE room", "Owner");
    const pairing = first.createHostPairing(created.session.id, created.memberToken, 10);
    const host = first.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(first, created.session.id, created.memberToken, host.memberToken);
    const queued = first.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "read", path: "README.md" },
    );
    first.close();

    const restarted = new SessionStore(filename);
    try {
      expect(
        restarted.getWorkspaceFileOperation(
          created.session.id,
          created.memberToken,
          queued.id,
        ).status,
      ).toBe("queued");
      expect(
        restarted.claimNextWorkspaceFileOperation(
          created.session.id,
          host.memberToken,
        ).operation?.id,
      ).toBe(queued.id);
    } finally {
      restarted.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("revokes the old host and fails prior-generation operations on re-pair", () => {
    const store = createStore();
    const created = store.createSession("Re-pair room", "Owner");
    const firstPairing = store.createHostPairing(
      created.session.id,
      created.memberToken,
      10,
    );
    const firstHost = store.claimHostPairing(
      firstPairing.pairingToken,
      "Old PC",
      "Old project",
    );
    store.publishWorkspaceCatalog(created.session.id, firstHost.memberToken, {
      deviceLabel: "Old PC",
      rootLabel: "Old project",
      threads: [{ id: "thread-old", name: "Old task", preview: "", updatedAt: null }],
    });
    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-old");
    store.publishWorkspaceSnapshot(created.session.id, firstHost.memberToken, {
      threadId: "thread-old",
      history: [],
      files: [
        {
          path: "old.ts",
          content: "export const oldValue = true;",
          size: 29,
          modifiedAt: "2026-07-27T00:00:00.000Z",
          sha256: createHash("sha256").update("export const oldValue = true;").digest("hex"),
        },
      ],
    });
    const queued = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      {
        kind: "write",
        path: "old.ts",
        content: "export const newValue = true;",
        expectedSha256: "a".repeat(64),
      },
    );

    const secondPairing = store.createHostPairing(
      created.session.id,
      created.memberToken,
      10,
    );
    const secondHost = store.claimHostPairing(
      secondPairing.pairingToken,
      "New PC",
      "New project",
    );

    expect(
      store.getWorkspaceFileOperation(created.session.id, created.memberToken, queued.id),
    ).toMatchObject({ status: "failed", errorCode: "host_repaired" });
    expect(
      store.db
        .prepare(
          "SELECT request_content, result_content FROM workspace_file_operations WHERE id = ?",
        )
        .get(queued.id),
    ).toEqual({ request_content: null, result_content: null });
    expect(store.getWorkspace(created.session.id, created.memberToken).files).toEqual([]);
    expect(() =>
      store.claimNextWorkspaceFileOperation(created.session.id, firstHost.memberToken),
    ).toThrow();
    expect(() =>
      store.publishWorkspaceCatalog(created.session.id, firstHost.memberToken, {
        deviceLabel: "Old PC",
        rootLabel: "Old project",
        threads: [],
      }),
    ).toThrow();
    expect(() =>
      store.claimNextWorkspaceFileOperation(created.session.id, created.memberToken),
    ).toThrowError(/host token/i);
    expect(
      store.publishWorkspaceCatalog(created.session.id, secondHost.memberToken, {
        deviceLabel: "New PC",
        rootLabel: "New project",
        threads: [],
      }).rootLabel,
    ).toBe("New project");
  });

  it("rotates stale claim leases and rejects completion from the old lease", () => {
    const store = createStore();
    const created = store.createSession("Lease room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const queued = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "read", path: "src/value.ts" },
    );
    const firstClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.db
      .prepare("UPDATE workspace_file_operations SET started_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", queued.id);
    const secondClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    expect(secondClaim.leaseId).not.toBe(firstClaim.leaseId);
    const content = "export const value = 1;";
    const completion = {
      status: "completed" as const,
      file: {
        path: "src/value.ts",
        content,
        size: Buffer.byteLength(content),
        modifiedAt: "2026-07-27T00:00:00.000Z",
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    };
    expect(() =>
      store.completeWorkspaceFileOperation(created.session.id, host.memberToken, queued.id, {
        ...completion,
        leaseId: firstClaim.leaseId,
      }),
    ).toThrowError(/currently claimed/i);
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      queued.id,
      secondClaim.leaseId,
    );
    expect(
      store.completeWorkspaceFileOperation(created.session.id, host.memberToken, queued.id, {
        ...completion,
        leaseId: secondClaim.leaseId,
      }).status,
    ).toBe("completed");
  });

  it("expires a stalled lease without waiting for a second claimant", () => {
    const store = createStore();
    const created = store.createSession("Expired lease room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const queued = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "read", path: "src/stalled.ts" },
    );
    const claim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.db
      .prepare("UPDATE workspace_file_operations SET lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", queued.id);

    expect(() =>
      store.confirmWorkspaceFileOperationLease(
        created.session.id,
        host.memberToken,
        queued.id,
        claim.leaseId,
      ),
    ).toThrowError(/lease expired/i);
    expect(() =>
      store.completeWorkspaceFileOperation(created.session.id, host.memberToken, queued.id, {
        status: "failed",
        leaseId: claim.leaseId,
        errorCode: "test",
        errorMessage: "test",
      }),
    ).toThrowError(/not currently claimed/i);
  });

  it("rechecks member write permission when confirming and completing a lease", () => {
    const store = createStore();
    const created = store.createSession("Revoked lease room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const invite = store.createInvite(created.session.id, created.memberToken, 10, 1);
    const guest = store.joinInvite(invite.inviteToken, "Editor");
    store.approveMember(created.session.id, created.memberToken, guest.member.id);
    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "workspace-write",
    );
    const revokedSha256 = publishIdeFile(
      store,
      created.session.id,
      host.memberToken,
      "src/revoked.ts",
      "export const previous = true;",
    );
    const queued = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      {
        kind: "write",
        path: "src/revoked.ts",
        content: "export {};",
        expectedSha256: revokedSha256,
      },
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

    expect(() =>
      store.confirmWorkspaceFileOperationLease(
        created.session.id,
        host.memberToken,
        queued.id,
        claim.leaseId,
      ),
    ).toThrowError(/removed before host execution/i);
    expect(
      store.getWorkspaceFileOperation(created.session.id, created.memberToken, queued.id),
    ).toMatchObject({ status: "failed", errorCode: "workspace_read_only" });
    expect(
      store.db
        .prepare("SELECT request_content, lease_id FROM workspace_file_operations WHERE id = ?")
        .get(queued.id),
    ).toEqual({ request_content: null, lease_id: null });

    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "workspace-write",
    );
    const lateRevokedSha256 = publishIdeFile(
      store,
      created.session.id,
      host.memberToken,
      "src/late-revoked.ts",
      "export const previous = true;",
    );
    const lateRevoked = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      {
        kind: "write",
        path: "src/late-revoked.ts",
        content: "export const value = 1;",
        expectedSha256: lateRevokedSha256,
      },
    );
    const lateClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      lateRevoked.id,
      lateClaim.leaseId,
    );
    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "read-only",
    );
    const lateContent = "export const value = 1;";
    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        lateRevoked.id,
        {
          status: "completed",
          leaseId: lateClaim.leaseId,
          file: {
            path: lateRevoked.path,
            content: lateContent,
            size: Buffer.byteLength(lateContent),
            modifiedAt: "2026-07-27T00:00:00.000Z",
            sha256: createHash("sha256").update(lateContent).digest("hex"),
          },
        },
      ),
    ).toThrowError(/removed before host execution/i);
  });

});
