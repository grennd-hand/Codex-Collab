import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "../app-server/app-server-client.js";
import { DurableReceiptReconciler } from "./durable-receipt-reconciler.js";
import { DurableRecoveryBlockedError } from "./durable-recovery.js";
import type { LocalProfile, LocalProfileStore } from "./local-profile.js";
import { profile } from "../sync/workspace-sync-test-fixtures.js";

function profiles(initial: LocalProfile) {
  let current = structuredClone(initial);
  return {
    read: vi.fn(async () => current),
    mutate: vi.fn(async (operation: (value: LocalProfile) => LocalProfile) => {
      current = operation(current);
      return current;
    }),
    snapshot: () => current,
  };
}

function fileReceipt(phase: "executing" | "blocked", projectRoot = profile.projectRoot) {
  return {
    version: 1 as const,
    phase,
    relayUrl: profile.relayUrl,
    sessionId: profile.sessionId,
    memberId: profile.memberId,
    projectRoot,
    codexConfigRoot: null,
    operationId: "operation-1",
    requestedByMemberId: "editor-1",
    leaseId: "lease-1",
    hostGeneration: "generation-1",
    kind: "write" as const,
    path: "src/a.ts",
    destinationPath: null,
    expectedSha256: "",
    requestContentSha256: "hash",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:01.000Z",
  };
}

describe("DurableReceiptReconciler", () => {
  it("turns a crash-left executing file receipt into a typed permanent block", async () => {
    const store = profiles({ ...profile, fileOperationReceipt: fileReceipt("executing") });
    const reconciler = new DurableReceiptReconciler(
      store as unknown as LocalProfileStore,
      {} as CodexAppServerClient,
      async () => undefined,
    );

    await expect(reconciler.reconcile()).rejects.toBeInstanceOf(
      DurableRecoveryBlockedError,
    );
    expect(store.snapshot().fileOperationReceipt).toMatchObject({ phase: "blocked" });
  });

  it("fails closed when a receipt belongs to another approved root", async () => {
    const store = profiles({
      ...profile,
      fileOperationReceipt: fileReceipt("blocked", "C:\\other-project"),
    });
    const reconciler = new DurableReceiptReconciler(
      store as unknown as LocalProfileStore,
      {} as CodexAppServerClient,
      async () => undefined,
    );

    await expect(reconciler.reconcile()).rejects.toBeInstanceOf(
      DurableRecoveryBlockedError,
    );
  });
});
