import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WorkspaceFileOperation,
  WorkspaceFileOperationClaim,
  WorkspaceFileOperationConfirmation,
} from "@codex-collab/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSandbox } from "./file-sandbox.js";
import { DurableRecoveryBlockedError } from "./durable-recovery.js";
import {
  LocalProfileStore,
  type LocalFileOperationResult,
  type LocalProfile,
} from "./local-profile.js";
import { WorkspaceFileOperationJournal } from "./workspace-file-operation-receipts.js";
import { processNextWorkspaceFileOperation } from "./workspace-file-operations.js";
import { RelayRequestError } from "./relay-client.js";

const originalStateFile = process.env.CODEX_COLLAB_STATE_FILE;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalStateFile === undefined) {
    delete process.env.CODEX_COLLAB_STATE_FILE;
  } else {
    process.env.CODEX_COLLAB_STATE_FILE = originalStateFile;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-collab-file-receipt-"));
  temporaryDirectories.push(root);
  process.env.CODEX_COLLAB_STATE_FILE = join(root, "profile.json");
  const profile: LocalProfile = {
    relayUrl: "https://relay.example",
    sessionId: "session-1",
    memberId: "owner-1",
    displayName: "Owner",
    role: "owner",
    memberToken: "host-token",
    projectRoot: root,
  };
  const profiles = new LocalProfileStore();
  await profiles.write(profile);
  return { root, profile, profiles, sandbox: await FileSandbox.create(root) };
}

function confirmation(
  values: Partial<WorkspaceFileOperationConfirmation> = {},
): WorkspaceFileOperationConfirmation {
  return {
    id: "operation-1",
    sessionId: "session-1",
    requestedByMemberId: "member-1",
    requestedByDisplayName: "Editor",
    hostGeneration: "generation-1",
    kind: "write",
    path: "file.txt",
    destinationPath: null,
    expectedSha256: "",
    requestContent: "updated",
    status: "processing",
    resultFileMetadata: null,
    resultFile: null,
    errorCode: null,
    errorMessage: null,
    requestedAt: "2026-07-29T00:00:00.000Z",
    startedAt: "2026-07-29T00:00:01.000Z",
    completedAt: null,
    leaseId: "lease-1",
    leaseExpiresAt: "2026-07-29T00:01:00.000Z",
    ...values,
  };
}

function claimFrom(
  operation: WorkspaceFileOperationConfirmation,
): WorkspaceFileOperationClaim {
  const { requestContent: _content, ...claim } = operation;
  return { ...claim, expectedSha256: null };
}

function terminalOperation(
  operation: WorkspaceFileOperationConfirmation,
  result: LocalFileOperationResult,
): WorkspaceFileOperation {
  const {
    requestContent: _requestContent,
    leaseId: _leaseId,
    leaseExpiresAt: _leaseExpiresAt,
    ...base
  } = operation;
  return {
    ...base,
    status: result.status,
    resultFileMetadata: result.file
      ? {
          path: result.file.path,
          size: result.file.size,
          modifiedAt: result.file.modifiedAt,
          sha256: result.file.sha256,
        }
      : null,
    resultFile: result.file ?? null,
    errorCode: result.status === "failed" ? result.errorCode : null,
    errorMessage: result.status === "failed" ? result.errorMessage : null,
    completedAt: "2026-07-29T00:00:02.000Z",
  };
}

function queuedOperation(
  operation: WorkspaceFileOperationConfirmation,
): WorkspaceFileOperation {
  const {
    requestContent: _requestContent,
    leaseId: _leaseId,
    leaseExpiresAt: _leaseExpiresAt,
    ...base
  } = operation;
  return {
    ...base,
    status: "queued",
    startedAt: null,
    resultFileMetadata: null,
    resultFile: null,
    errorCode: null,
    errorMessage: null,
    completedAt: null,
  };
}

function relayFor(
  claim: WorkspaceFileOperationClaim,
  confirmed: WorkspaceFileOperationConfirmation,
) {
  return {
    claimNextWorkspaceFileOperation: vi.fn().mockResolvedValue(claim),
    confirmWorkspaceFileOperationLease: vi.fn().mockResolvedValue(confirmed),
    completeWorkspaceFileOperation: vi.fn(),
    releaseWorkspaceFileOperationLease: vi
      .fn()
      .mockResolvedValue(queuedOperation(confirmed)),
  };
}

describe("workspace file operation receipts", () => {
  it("persists intent and executing state before the first local side effect", async () => {
    const { profile, profiles, sandbox } = await fixture();
    const confirmed = confirmation();
    const relay = relayFor(claimFrom(confirmed), confirmed);
    const order: string[] = [];
    const mutate = profiles.mutate.bind(profiles);
    vi.spyOn(profiles, "mutate").mockImplementation(async (update) => {
      const updated = await mutate(update);
      if (updated.fileOperationReceipt?.phase) {
        order.push(updated.fileOperationReceipt.phase);
      }
      return updated;
    });
    const originalWrite = sandbox.write.bind(sandbox);
    vi.spyOn(sandbox, "write").mockImplementation(async (...args) => {
      order.push("disk");
      await expect(profiles.read()).resolves.toMatchObject({
        fileOperationReceipt: {
          operationId: confirmed.id,
          phase: "executing",
        },
      });
      return originalWrite(...args);
    });
    relay.completeWorkspaceFileOperation.mockImplementation(
      async (_sessionId, _token, _operationId, input) => {
        order.push("relay");
        return terminalOperation(confirmed, input);
      },
    );

    await processNextWorkspaceFileOperation(
      profile,
      profiles,
      relay as never,
      sandbox,
    );

    expect(sandbox.write).toHaveBeenCalledTimes(1);
    expect(order.slice(0, 5)).toEqual([
      "intent",
      "executing",
      "disk",
      "result",
      "relay",
    ]);
    await expect(profiles.read()).resolves.not.toHaveProperty("fileOperationReceipt");
  });

  it("replays a durable result after an acknowledgement crash without re-executing", async () => {
    const { profile, profiles, sandbox } = await fixture();
    const confirmed = confirmation();
    const relay = relayFor(claimFrom(confirmed), confirmed);
    const originalWrite = sandbox.write.bind(sandbox);
    const write = vi.spyOn(sandbox, "write").mockImplementation((...args) =>
      originalWrite(...args),
    );
    relay.completeWorkspaceFileOperation.mockRejectedValueOnce(
      new Error("connection lost after Relay commit"),
    );

    await expect(
      processNextWorkspaceFileOperation(profile, profiles, relay as never, sandbox),
    ).rejects.toThrow(/connection lost/i);
    const stored = await profiles.read();
    expect(stored?.fileOperationReceipt).toMatchObject({
      phase: "result",
      operationId: confirmed.id,
      leaseId: confirmed.leaseId,
      hostGeneration: confirmed.hostGeneration,
      result: { status: "completed" },
    });
    const exactResult = stored!.fileOperationReceipt!.result!;
    relay.completeWorkspaceFileOperation.mockResolvedValueOnce(
      terminalOperation(confirmed, exactResult),
    );

    await processNextWorkspaceFileOperation(
      profile,
      profiles,
      relay as never,
      sandbox,
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(relay.claimNextWorkspaceFileOperation).toHaveBeenCalledTimes(1);
    expect(relay.completeWorkspaceFileOperation).toHaveBeenLastCalledWith(
      profile.sessionId,
      profile.memberToken,
      confirmed.id,
      { ...exactResult, leaseId: confirmed.leaseId },
    );
    await expect(profiles.read()).resolves.not.toHaveProperty("fileOperationReceipt");
  });

  it("turns an ambiguous executing intent into a permanent fail-closed receipt", async () => {
    const { profile, profiles, sandbox } = await fixture();
    const confirmed = confirmation();
    const claim = claimFrom(confirmed);
    const journal = new WorkspaceFileOperationJournal(profiles, profile);
    const intent = await journal.recordIntent(claim, confirmed);
    await journal.markExecuting(intent, confirmed);
    const relay = relayFor(claim, confirmed);

    await expect(
      processNextWorkspaceFileOperation(profile, profiles, relay as never, sandbox),
    ).rejects.toThrow(/may already have changed local files/i);
    await expect(profiles.read()).resolves.toMatchObject({
      fileOperationReceipt: { phase: "blocked", operationId: confirmed.id },
    });
    await expect(
      processNextWorkspaceFileOperation(profile, profiles, relay as never, sandbox),
    ).rejects.toThrow(/may already have changed local files/i);
    expect(relay.claimNextWorkspaceFileOperation).not.toHaveBeenCalled();
  });

  it("releases a confirmed intent before clearing it when room admission closes", async () => {
    const { profile, profiles, sandbox } = await fixture();
    const confirmed = confirmation();
    const relay = relayFor(claimFrom(confirmed), confirmed);
    const order: string[] = [];
    relay.claimNextWorkspaceFileOperation.mockImplementation(async () => {
      order.push("claim");
      return claimFrom(confirmed);
    });
    relay.confirmWorkspaceFileOperationLease.mockImplementation(async () => {
      order.push("confirm");
      return confirmed;
    });
    const mutate = profiles.mutate.bind(profiles);
    vi.spyOn(profiles, "mutate").mockImplementation(async (update) => {
      const updated = await mutate(update);
      if (updated.fileOperationReceipt?.phase === "intent") order.push("intent");
      return updated;
    });
    relay.releaseWorkspaceFileOperationLease.mockImplementation(async () => {
      order.push("release");
      await expect(profiles.read()).resolves.toMatchObject({
        fileOperationReceipt: { phase: "intent", leaseId: confirmed.leaseId },
      });
      return queuedOperation(confirmed);
    });
    let checks = 0;
    const admission = { isAllowed: () => ++checks < 3 };
    const write = vi.spyOn(sandbox, "write");

    await expect(
      processNextWorkspaceFileOperation(
        profile,
        profiles,
        relay as never,
        sandbox,
        null,
        admission,
      ),
    ).resolves.toBeNull();

    expect(relay.confirmWorkspaceFileOperationLease).toHaveBeenCalledTimes(1);
    expect(relay.releaseWorkspaceFileOperationLease).toHaveBeenCalledWith(
      profile.sessionId,
      profile.memberToken,
      confirmed.id,
      { leaseId: confirmed.leaseId },
    );
    expect(order.slice(0, 4)).toEqual(["claim", "confirm", "intent", "release"]);
    expect(write).not.toHaveBeenCalled();
    expect(relay.completeWorkspaceFileOperation).not.toHaveBeenCalled();
    await expect(profiles.read()).resolves.not.toHaveProperty("fileOperationReceipt");
  });

  it("releases a recovered intent before a later FIFO claim", async () => {
    const { profile, profiles, sandbox } = await fixture();
    const confirmed = confirmation();
    const claim = claimFrom(confirmed);
    const journal = new WorkspaceFileOperationJournal(profiles, profile);
    await journal.recordIntent(claim, confirmed);
    const relay = relayFor(claim, confirmed);
    const write = vi.spyOn(sandbox, "write");

    await expect(
      processNextWorkspaceFileOperation(profile, profiles, relay as never, sandbox),
    ).resolves.toMatchObject({ id: confirmed.id, status: "queued" });
    expect(relay.releaseWorkspaceFileOperationLease).toHaveBeenCalledTimes(1);
    expect(relay.claimNextWorkspaceFileOperation).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    await expect(profiles.read()).resolves.not.toHaveProperty("fileOperationReceipt");

    relay.claimNextWorkspaceFileOperation.mockResolvedValueOnce(null);
    await processNextWorkspaceFileOperation(profile, profiles, relay as never, sandbox);
    expect(relay.claimNextWorkspaceFileOperation).toHaveBeenCalledTimes(1);
  });

  it("retains the confirmed intent when admission closes and release retries fail", async () => {
    const { profile, profiles, sandbox } = await fixture();
    const confirmed = confirmation();
    const relay = relayFor(claimFrom(confirmed), confirmed);
    relay.releaseWorkspaceFileOperationLease.mockRejectedValue(
      new Error("temporary network failure"),
    );
    const write = vi.spyOn(sandbox, "write");
    let checks = 0;
    const admission = { isAllowed: () => ++checks < 3 };

    await expect(
      processNextWorkspaceFileOperation(
        profile,
        profiles,
        relay as never,
        sandbox,
        null,
        admission,
      ),
    ).rejects.toThrow(/temporary network failure/i);
    await expect(
      processNextWorkspaceFileOperation(profile, profiles, relay as never, sandbox),
    ).rejects.toThrow(/temporary network failure/i);

    expect(relay.releaseWorkspaceFileOperationLease).toHaveBeenCalledTimes(2);
    expect(relay.claimNextWorkspaceFileOperation).toHaveBeenCalledTimes(1);
    expect(relay.confirmWorkspaceFileOperationLease).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    await expect(profiles.read()).resolves.toMatchObject({
      fileOperationReceipt: { phase: "intent", operationId: confirmed.id },
    });
  });

  it.each([404, 409])(
    "fails closed and retains the intent when lease release returns %s",
    async (status) => {
      const { profile, profiles, sandbox } = await fixture();
      const confirmed = confirmation();
      const journal = new WorkspaceFileOperationJournal(profiles, profile);
      await journal.recordIntent(claimFrom(confirmed), confirmed);
      const relay = relayFor(claimFrom(confirmed), confirmed);
      relay.releaseWorkspaceFileOperationLease.mockRejectedValue(
        new RelayRequestError(status, "release_failed", "release unavailable"),
      );

      await expect(
        processNextWorkspaceFileOperation(profile, profiles, relay as never, sandbox),
      ).rejects.toBeInstanceOf(DurableRecoveryBlockedError);
      expect(relay.claimNextWorkspaceFileOperation).not.toHaveBeenCalled();
      await expect(profiles.read()).resolves.toMatchObject({
        fileOperationReceipt: { phase: "intent", operationId: confirmed.id },
      });
    },
  );

  it("retains the intent when Relay confirms a mismatched release", async () => {
    const { profile, profiles, sandbox } = await fixture();
    const confirmed = confirmation();
    const journal = new WorkspaceFileOperationJournal(profiles, profile);
    await journal.recordIntent(claimFrom(confirmed), confirmed);
    const relay = relayFor(claimFrom(confirmed), confirmed);
    relay.releaseWorkspaceFileOperationLease.mockResolvedValue({
      ...queuedOperation(confirmed),
      hostGeneration: "different-generation",
    });

    await expect(
      processNextWorkspaceFileOperation(profile, profiles, relay as never, sandbox),
    ).rejects.toBeInstanceOf(DurableRecoveryBlockedError);
    expect(relay.claimNextWorkspaceFileOperation).not.toHaveBeenCalled();
    await expect(profiles.read()).resolves.toMatchObject({
      fileOperationReceipt: { phase: "intent", hostGeneration: "generation-1" },
    });
  });

  it.each([
    ["relayUrl", "https://other.example"],
    ["sessionId", "session-2"],
    ["projectRoot", "C:\\other-root"],
  ] as const)("fails closed before claim when %s changes", async (field, value) => {
    const { profile, profiles, sandbox } = await fixture();
    await profiles.update({ [field]: value });
    const confirmed = confirmation();
    const relay = relayFor(claimFrom(confirmed), confirmed);

    await expect(
      processNextWorkspaceFileOperation(profile, profiles, relay as never, sandbox),
    ).rejects.toThrow(/profile or shared root changed/i);
    expect(relay.claimNextWorkspaceFileOperation).not.toHaveBeenCalled();
  });

  it("retains an existing receipt when the profile root changes", async () => {
    const { profile, profiles, sandbox } = await fixture();
    const confirmed = confirmation();
    const journal = new WorkspaceFileOperationJournal(profiles, profile);
    await journal.recordIntent(claimFrom(confirmed), confirmed);
    await profiles.update({ projectRoot: "C:\\different-root" });
    const relay = relayFor(claimFrom(confirmed), confirmed);

    await expect(
      processNextWorkspaceFileOperation(profile, profiles, relay as never, sandbox),
    ).rejects.toThrow(/profile or shared root changed/i);
    await expect(profiles.read()).resolves.toMatchObject({
      projectRoot: "C:\\different-root",
      fileOperationReceipt: {
        phase: "intent",
        operationId: confirmed.id,
      },
    });
    expect(relay.claimNextWorkspaceFileOperation).not.toHaveBeenCalled();
  });

  it.each(["hostGeneration", "leaseId"] as const)(
    "persists a permanent block when confirmation %s mismatches the claim",
    async (field) => {
      const { profile, profiles, sandbox } = await fixture();
      const confirmed = confirmation();
      const claim = claimFrom(confirmed);
      const relay = relayFor(claim, {
        ...confirmed,
        [field]: `different-${field}`,
      });

      await expect(
        processNextWorkspaceFileOperation(profile, profiles, relay as never, sandbox),
      ).rejects.toThrow(/generation or lease/i);
      await expect(profiles.read()).resolves.toMatchObject({
        fileOperationReceipt: {
          phase: "blocked",
          operationId: claim.id,
          leaseId: claim.leaseId,
          hostGeneration: claim.hostGeneration,
        },
      });
      expect(relay.completeWorkspaceFileOperation).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["read", "completed"],
    ["write", "completed"],
    ["mkdir", "completed"],
    ["rename", "completed"],
    ["read", "failed"],
    ["write", "failed"],
    ["mkdir", "failed"],
    ["rename", "failed"],
  ] as const)(
    "persists the exact %s/%s result before Relay completion",
    async (kind, expectedStatus) => {
      const { root, profile, profiles, sandbox } = await fixture();
      await writeFile(join(root, "source.txt"), "original", "utf8");
      const source = await sandbox.read("source.txt");
      if (kind === "rename" && expectedStatus === "failed") {
        await writeFile(join(root, "occupied.txt"), "occupied", "utf8");
      }
      const failedValues: Record<
        typeof kind,
        Partial<WorkspaceFileOperationConfirmation>
      > = {
        read: {
          kind: "read", path: "missing.txt", expectedSha256: null, requestContent: null,
        },
        write: {
          kind: "write", path: "source.txt", expectedSha256: null, requestContent: null,
        },
        mkdir: {
          kind: "mkdir", path: "source.txt", expectedSha256: null, requestContent: null,
        },
        rename: {
          kind: "rename",
          path: "source.txt",
          destinationPath: "occupied.txt",
          expectedSha256: source.sha256,
          requestContent: null,
        },
      };
      const values: Partial<WorkspaceFileOperationConfirmation> =
        expectedStatus === "failed"
          ? failedValues[kind]
          : kind === "read"
            ? { kind, path: "source.txt", expectedSha256: null, requestContent: null }
            : kind === "write"
              ? {
                  kind,
                  path: "source.txt",
                  expectedSha256: source.sha256,
                  requestContent: "changed",
                }
              : kind === "mkdir"
                ? { kind, path: "new-dir", expectedSha256: null, requestContent: null }
                : {
                    kind,
                    path: "source.txt",
                    destinationPath: "renamed.txt",
                    expectedSha256: source.sha256,
                    requestContent: null,
                  };
      const confirmed = confirmation(values);
      const relay = relayFor(claimFrom(confirmed), confirmed);
      relay.completeWorkspaceFileOperation.mockRejectedValueOnce(new Error("ack unavailable"));

      await expect(
        processNextWorkspaceFileOperation(profile, profiles, relay as never, sandbox),
      ).rejects.toThrow(/ack unavailable/i);

      const receipt = (await profiles.read())?.fileOperationReceipt;
      expect(receipt).toMatchObject({
        phase: "result",
        kind,
        operationId: confirmed.id,
        leaseId: confirmed.leaseId,
        hostGeneration: confirmed.hostGeneration,
        result: { status: expectedStatus },
      });
      expect(relay.completeWorkspaceFileOperation).toHaveBeenCalledWith(
        profile.sessionId,
        profile.memberToken,
        confirmed.id,
        { ...receipt!.result!, leaseId: confirmed.leaseId },
      );
      if (kind === "write" && expectedStatus === "completed") {
        await expect(readFile(join(root, "source.txt"), "utf8")).resolves.toBe("changed");
      }
    },
  );
});
