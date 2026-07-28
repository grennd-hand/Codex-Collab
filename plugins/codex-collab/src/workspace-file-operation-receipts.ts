import { createHash } from "node:crypto";
import type {
  WorkspaceFileOperation,
  WorkspaceFileOperationClaim,
  WorkspaceFileOperationConfirmation,
} from "@codex-collab/protocol";
import {
  type LocalFileOperationReceipt,
  type LocalFileOperationResult,
  type LocalProfile,
  LocalProfileStore,
} from "./local-profile.js";
import { RelayRequestError, type RelayClient } from "./relay-client.js";
import { DurableRecoveryBlockedError } from "./durable-recovery.js";

type ReceiptRelay = Pick<
  RelayClient,
  "completeWorkspaceFileOperation" | "releaseWorkspaceFileOperationLease"
>;

const ambiguousExecutionMessage =
  "A confirmed workspace file operation may already have changed local files. " +
  "Automatic recovery is blocked to prevent duplicate side effects.";

function contentSha256(content: string | null): string | null {
  return content === null
    ? null
    : createHash("sha256").update(content, "utf8").digest("hex");
}

function profileIdentityMatches(profile: LocalProfile, expected: LocalProfile): boolean {
  return (
    profile.relayUrl === expected.relayUrl &&
    profile.sessionId === expected.sessionId &&
    profile.memberId === expected.memberId &&
    profile.projectRoot === expected.projectRoot &&
    (profile.codexConfigRoot ?? null) === (expected.codexConfigRoot ?? null)
  );
}

function receiptProfileMatches(receipt: LocalFileOperationReceipt, profile: LocalProfile): boolean {
  return (
    receipt.relayUrl === profile.relayUrl &&
    receipt.sessionId === profile.sessionId &&
    receipt.memberId === profile.memberId &&
    receipt.projectRoot === profile.projectRoot &&
    receipt.codexConfigRoot === (profile.codexConfigRoot ?? null)
  );
}

function operationIdentityMatches(
  receipt: LocalFileOperationReceipt,
  operation: WorkspaceFileOperationConfirmation,
): boolean {
  return (
    receipt.operationId === operation.id &&
    receipt.requestedByMemberId === operation.requestedByMemberId &&
    receipt.sessionId === operation.sessionId &&
    receipt.leaseId === operation.leaseId &&
    receipt.hostGeneration === operation.hostGeneration &&
    receipt.kind === operation.kind &&
    receipt.path === operation.path &&
    receipt.destinationPath === operation.destinationPath &&
    receipt.expectedSha256 === operation.expectedSha256 &&
    receipt.requestContentSha256 === contentSha256(operation.requestContent)
  );
}

function assertConfirmationMatchesClaim(
  claim: WorkspaceFileOperationClaim,
  confirmed: WorkspaceFileOperationConfirmation,
): void {
  const matches =
    claim.id === confirmed.id &&
    claim.sessionId === confirmed.sessionId &&
    claim.requestedByMemberId === confirmed.requestedByMemberId &&
    claim.requestedByDisplayName === confirmed.requestedByDisplayName &&
    claim.hostGeneration === confirmed.hostGeneration &&
    claim.kind === confirmed.kind &&
    claim.path === confirmed.path &&
    claim.destinationPath === confirmed.destinationPath &&
    claim.status === confirmed.status &&
    claim.requestedAt === confirmed.requestedAt &&
    claim.startedAt === confirmed.startedAt &&
    claim.leaseId === confirmed.leaseId &&
    claim.leaseExpiresAt === confirmed.leaseExpiresAt;
  if (!matches) {
    throw new Error(
      "Workspace file operation confirmation did not match its claimed generation or lease",
    );
  }
}

function receiptFromConfirmation(
  profile: LocalProfile,
  operation: WorkspaceFileOperationConfirmation,
): LocalFileOperationReceipt {
  const timestamp = new Date().toISOString();
  return {
    version: 1,
    phase: "intent",
    relayUrl: profile.relayUrl,
    sessionId: profile.sessionId,
    memberId: profile.memberId,
    projectRoot: profile.projectRoot,
    codexConfigRoot: profile.codexConfigRoot ?? null,
    operationId: operation.id,
    requestedByMemberId: operation.requestedByMemberId,
    leaseId: operation.leaseId,
    hostGeneration: operation.hostGeneration,
    kind: operation.kind,
    path: operation.path,
    destinationPath: operation.destinationPath,
    expectedSha256: operation.expectedSha256,
    requestContentSha256: contentSha256(operation.requestContent),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function withoutFileReceipt(profile: LocalProfile): LocalProfile {
  const { fileOperationReceipt: _removed, ...remaining } = profile;
  return remaining;
}

function receiptsMatch(
  current: LocalFileOperationReceipt | undefined,
  expected: LocalFileOperationReceipt,
): boolean {
  return JSON.stringify(current) === JSON.stringify(expected);
}

function completionInput(receipt: LocalFileOperationReceipt) {
  if (receipt.phase !== "result" || !receipt.result) {
    throw new DurableRecoveryBlockedError(
      "Workspace file operation result receipt is incomplete",
    );
  }
  return { ...receipt.result, leaseId: receipt.leaseId };
}

function releaseFailure(error: unknown): never {
  if (
    error instanceof RelayRequestError &&
    (error.status === 404 || error.status === 409)
  ) {
    throw new DurableRecoveryBlockedError(
      "Relay cannot safely release the pending workspace file operation lease",
      { cause: error },
    );
  }
  throw error;
}

export class WorkspaceFileOperationJournal {
  constructor(
    private readonly profiles: LocalProfileStore,
    private readonly profile: LocalProfile,
  ) {}

  private assertCurrentProfile(current: LocalProfile): void {
    if (!profileIdentityMatches(current, this.profile)) {
      throw new DurableRecoveryBlockedError(
        "Workspace file operation recovery is blocked because the local profile or shared root changed",
      );
    }
  }

  private async transition(
    expected: LocalFileOperationReceipt,
    update: (receipt: LocalFileOperationReceipt) => LocalFileOperationReceipt | null,
  ): Promise<LocalFileOperationReceipt | null> {
    let next: LocalFileOperationReceipt | null = null;
    await this.profiles.mutate((current) => {
      this.assertCurrentProfile(current);
      if (!receiptsMatch(current.fileOperationReceipt, expected)) {
        throw new DurableRecoveryBlockedError(
          "Workspace file operation receipt changed unexpectedly",
        );
      }
      next = update(expected);
      return next
        ? { ...current, fileOperationReceipt: next }
        : withoutFileReceipt(current);
    });
    return next;
  }

  async reconcileBeforeClaim(
    relay: ReceiptRelay,
  ): Promise<WorkspaceFileOperation | null> {
    const current = await this.profiles.read();
    if (!current) {
      throw new Error("No active Codex Collab profile. Create or join a session first.");
    }
    this.assertCurrentProfile(current);
    const receipt = current.fileOperationReceipt;
    if (!receipt) return null;
    if (!receiptProfileMatches(receipt, current)) {
      throw new DurableRecoveryBlockedError(
        "Workspace file operation recovery is blocked because its profile or shared root no longer matches",
      );
    }
    if (receipt.phase === "intent") {
      return this.releaseIntent(relay, receipt);
    }
    if (receipt.phase === "executing") {
      const blocked = await this.transition(receipt, (value) => ({
        ...value,
        phase: "blocked",
        diagnostic: ambiguousExecutionMessage,
        updatedAt: new Date().toISOString(),
      }));
      throw new DurableRecoveryBlockedError(
        blocked?.diagnostic ?? ambiguousExecutionMessage,
      );
    }
    if (receipt.phase === "blocked") {
      throw new DurableRecoveryBlockedError(
        receipt.diagnostic ?? ambiguousExecutionMessage,
      );
    }
    const operation = await relay.completeWorkspaceFileOperation(
      receipt.sessionId,
      this.profile.memberToken,
      receipt.operationId,
      completionInput(receipt),
    );
    if (
      operation.id !== receipt.operationId ||
      operation.hostGeneration !== receipt.hostGeneration ||
      operation.status !== receipt.result?.status
    ) {
      throw new DurableRecoveryBlockedError(
        "Relay returned a mismatched workspace file operation receipt",
      );
    }
    await this.transition(receipt, () => null);
    return operation;
  }

  async releaseIntent(
    relay: ReceiptRelay,
    receipt: LocalFileOperationReceipt,
    operation?: WorkspaceFileOperationConfirmation,
  ): Promise<WorkspaceFileOperation> {
    if (
      receipt.phase !== "intent" ||
      (operation !== undefined && !operationIdentityMatches(receipt, operation))
    ) {
      throw new DurableRecoveryBlockedError(
        "Workspace file operation intent no longer matches its confirmed lease",
      );
    }
    let released: WorkspaceFileOperation;
    try {
      released = await relay.releaseWorkspaceFileOperationLease(
        receipt.sessionId,
        this.profile.memberToken,
        receipt.operationId,
        { leaseId: receipt.leaseId },
      );
    } catch (error) {
      releaseFailure(error);
    }
    if (
      released.id !== receipt.operationId ||
      released.sessionId !== receipt.sessionId ||
      released.hostGeneration !== receipt.hostGeneration ||
      released.status !== "queued"
    ) {
      throw new DurableRecoveryBlockedError(
        "Relay returned a mismatched workspace file operation lease release",
      );
    }
    await this.transition(receipt, () => null);
    return released;
  }

  async recordIntent(
    claim: WorkspaceFileOperationClaim,
    confirmed: WorkspaceFileOperationConfirmation,
  ): Promise<LocalFileOperationReceipt> {
    try {
      assertConfirmationMatchesClaim(claim, confirmed);
      if (confirmed.sessionId !== this.profile.sessionId) {
        throw new Error("Workspace file operation confirmation belongs to another profile");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordBlockedClaim(claim, message);
      throw new DurableRecoveryBlockedError(message, { cause: error });
    }
    const receipt = receiptFromConfirmation(this.profile, confirmed);
    await this.profiles.mutate((current) => {
      this.assertCurrentProfile(current);
      if (current.fileOperationReceipt) {
        throw new DurableRecoveryBlockedError(
          "A workspace file operation receipt is already pending",
        );
      }
      return { ...current, fileOperationReceipt: receipt };
    });
    return receipt;
  }

  private async recordBlockedClaim(
    claim: WorkspaceFileOperationClaim,
    diagnostic: string,
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.profiles.mutate((current) => {
      this.assertCurrentProfile(current);
      if (current.fileOperationReceipt) {
        throw new DurableRecoveryBlockedError(
          "A workspace file operation receipt is already pending",
        );
      }
      return {
        ...current,
        fileOperationReceipt: {
          version: 1,
          phase: "blocked",
          relayUrl: this.profile.relayUrl,
          sessionId: this.profile.sessionId,
          memberId: this.profile.memberId,
          projectRoot: this.profile.projectRoot,
          codexConfigRoot: this.profile.codexConfigRoot ?? null,
          operationId: claim.id,
          requestedByMemberId: claim.requestedByMemberId,
          leaseId: claim.leaseId,
          hostGeneration: claim.hostGeneration,
          kind: claim.kind,
          path: claim.path,
          destinationPath: claim.destinationPath,
          expectedSha256: null,
          requestContentSha256: null,
          diagnostic,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      };
    });
  }

  async markExecuting(
    receipt: LocalFileOperationReceipt,
    operation: WorkspaceFileOperationConfirmation,
  ): Promise<LocalFileOperationReceipt> {
    if (receipt.phase !== "intent" || !operationIdentityMatches(receipt, operation)) {
      throw new DurableRecoveryBlockedError(
        "Workspace file operation intent no longer matches its confirmation",
      );
    }
    return (await this.transition(receipt, (value) => ({
      ...value,
      phase: "executing",
      updatedAt: new Date().toISOString(),
    })))!;
  }

  async recordResult(
    receipt: LocalFileOperationReceipt,
    operation: WorkspaceFileOperationConfirmation,
    result: LocalFileOperationResult,
  ): Promise<LocalFileOperationReceipt> {
    if (receipt.phase !== "executing" || !operationIdentityMatches(receipt, operation)) {
      throw new DurableRecoveryBlockedError(
        "Workspace file operation execution receipt no longer matches",
      );
    }
    return (await this.transition(receipt, (value) => ({
      ...value,
      phase: "result",
      result,
      updatedAt: new Date().toISOString(),
    })))!;
  }
}
