import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createStore, publishIdeFile, selectIdeThread } from "./session-store-test-support.js";

describe("SessionStore workspace rename operations", () => {
  it("moves the authoritative snapshot path after a guarded file rename", () => {
    const store = createStore();
    const created = store.createSession("Rename entry", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const content = "export const renamed = true;";
    const sha256 = publishIdeFile(
      store,
      created.session.id,
      host.memberToken,
      "src/original.ts",
      content,
    );
    const operation = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      {
        kind: "rename",
        path: "src/original.ts",
        destinationPath: "src/renamed.txt",
        expectedSha256: sha256,
      },
    );
    expect(operation.destinationPath).toBe("src/renamed.txt");
    const claim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    const confirmed = store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      operation.id,
      claim.leaseId,
    );
    expect(confirmed.destinationPath).toBe("src/renamed.txt");
    const completed = store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      operation.id,
      {
        status: "completed",
        leaseId: claim.leaseId,
        file: {
          path: "src/renamed.txt",
          content,
          size: Buffer.byteLength(content),
          modifiedAt: "2026-07-28T00:00:00.000Z",
          sha256,
        },
      },
    );

    expect(completed.resultFile?.path).toBe("src/renamed.txt");
    expect(
      store
        .getWorkspace(created.session.id, created.memberToken)
        .files.map((file) => file.path),
    ).toEqual(["src/renamed.txt"]);
  });

  it("rewrites descendant file and directory paths after a directory rename", () => {
    const store = createStore();
    const created = store.createSession("Rename folder", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const content = "export {};";
    store.publishWorkspaceSnapshot(created.session.id, host.memberToken, {
      threadId: "thread-ide",
      history: [],
      directories: ["src", "src/folder", "src/folder/nested"],
      files: [{
        path: "src/folder/nested/entry.ts",
        content,
        size: Buffer.byteLength(content),
        modifiedAt: "2026-07-28T00:00:00.000Z",
        sha256: createHash("sha256").update(content).digest("hex"),
      }],
    });
    const operation = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      {
        kind: "rename",
        path: "src/folder",
        destinationPath: "src/renamed",
        expectedSha256: null,
      },
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
    store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      operation.id,
      { status: "completed", leaseId: claim.leaseId },
    );

    const workspace = store.getWorkspace(created.session.id, created.memberToken);
    expect(workspace.directories).toEqual(["src", "src/renamed", "src/renamed/nested"]);
    expect(workspace.files.map((file) => file.path)).toEqual([
      "src/renamed/nested/entry.ts",
    ]);
  });
});
