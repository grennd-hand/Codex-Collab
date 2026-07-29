import {
  DEFAULT_CODEX_PROMPT_OPTIONS,
  type Message,
} from "@codex-collab/protocol";
import type {
  CodexAppServerClient,
  CodexPromptSubmission,
} from "../app-server/app-server-client.js";
import type {
  LocalCommandReceipt,
  LocalProfile,
  LocalProfileStore,
} from "./local-profile.js";
import type { RelayClient } from "../relay/relay-client.js";
import { DurableRecoveryBlockedError } from "./durable-recovery.js";

export interface CommandAdmission {
  isAllowed(): boolean;
}

export interface CommandDelivery {
  messageId: string;
  submission: CodexPromptSubmission;
  recovered: boolean;
}

type CommandProfiles = Pick<LocalProfileStore, "read" | "mutate">;
type CommandRelay = Pick<
  RelayClient,
  "readMessageAttachment" | "updateMessageDeliveryStatus"
>;
type CommandCodex = Pick<
  CodexAppServerClient,
  "submitPeerPrompt" | "stopPeerPrompt"
> & Partial<Pick<CodexAppServerClient, "findPeerPromptTurnIds">>;

export class CommandOutboxBlockedError extends DurableRecoveryBlockedError {
  readonly code = "command_outbox_blocked";

  constructor(message: string) {
    super(message);
    this.name = "CommandOutboxBlockedError";
  }
}

function assertSameProfile(current: LocalProfile, expected: LocalProfile): void {
  if (
    current.sessionId !== expected.sessionId ||
    current.memberId !== expected.memberId ||
    current.relayUrl !== expected.relayUrl ||
    current.projectRoot !== expected.projectRoot
  ) {
    throw new CommandOutboxBlockedError(
      "The active Codex Collab profile changed while a command receipt was being processed",
    );
  }
}

function receiptDiagnostic(receipt: LocalCommandReceipt): string {
  return receipt.diagnostic ??
    `Command ${receipt.messageId} is blocked in durable phase ${receipt.phase}`;
}

async function persistIntent(
  profiles: CommandProfiles,
  profile: LocalProfile,
  message: Message,
  threadId: string,
): Promise<LocalCommandReceipt> {
  const timestamp = new Date().toISOString();
  let created: LocalCommandReceipt | null = null;
  await profiles.mutate((current) => {
    assertSameProfile(current, profile);
    if (current.commandReceipt) return current;
    created = {
      messageId: message.id,
      threadId,
      commandKind: message.kind as "codex_prompt" | "codex_stop",
      phase: "submitting",
      turnId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return { ...current, commandReceipt: created };
  });
  if (!created) {
    throw new CommandOutboxBlockedError(
      "Another durable Codex command receipt is already pending",
    );
  }
  return created;
}

async function persistSubmitted(
  profiles: CommandProfiles,
  profile: LocalProfile,
  receipt: LocalCommandReceipt,
  turnId: string | null,
): Promise<LocalCommandReceipt> {
  let submitted: LocalCommandReceipt | null = null;
  await profiles.mutate((current) => {
    assertSameProfile(current, profile);
    if (current.commandReceipt?.messageId !== receipt.messageId) {
      throw new CommandOutboxBlockedError("The durable command receipt changed after submission");
    }
    submitted = {
      ...current.commandReceipt,
      phase: "submitted",
      turnId,
      updatedAt: new Date().toISOString(),
    };
    return { ...current, commandReceipt: submitted };
  });
  return submitted!;
}

async function removeUnsubmittedIntent(
  profiles: CommandProfiles,
  profile: LocalProfile,
  messageId: string,
): Promise<void> {
  await profiles.mutate((current) => {
    assertSameProfile(current, profile);
    if (
      current.commandReceipt?.messageId !== messageId ||
      current.commandReceipt.phase !== "submitting"
    ) {
      return current;
    }
    const { commandReceipt: _removed, ...withoutReceipt } = current;
    return withoutReceipt;
  });
}

async function finalizeReceipt(
  profiles: CommandProfiles,
  profile: LocalProfile,
  receipt: LocalCommandReceipt,
): Promise<void> {
  await profiles.mutate((current) => {
    assertSameProfile(current, profile);
    if (current.commandReceipt?.messageId !== receipt.messageId) {
      throw new CommandOutboxBlockedError("The durable command receipt changed before Relay ack");
    }
    const forwarded = new Set(current.forwardedMessageIds ?? []);
    forwarded.add(receipt.messageId);
    const { commandReceipt: _removed, ...withoutReceipt } = current;
    return { ...withoutReceipt, forwardedMessageIds: [...forwarded] };
  });
}

async function acknowledgeReceipt(
  profiles: CommandProfiles,
  profile: LocalProfile,
  relay: CommandRelay,
  receipt: LocalCommandReceipt,
): Promise<void> {
  await relay.updateMessageDeliveryStatus(
    profile.sessionId,
    profile.memberToken,
    receipt.messageId,
    "submitted",
    receipt.turnId,
  );
  await finalizeReceipt(profiles, profile, receipt);
}

async function blockReceipt(
  profiles: CommandProfiles,
  profile: LocalProfile,
  receipt: LocalCommandReceipt,
  diagnostic: string,
): Promise<never> {
  await profiles.mutate((current) => {
    assertSameProfile(current, profile);
    if (current.commandReceipt?.messageId !== receipt.messageId) {
      throw new CommandOutboxBlockedError("The durable command receipt changed during recovery");
    }
    return {
      ...current,
      commandReceipt: {
        ...current.commandReceipt,
        phase: "blocked",
        diagnostic,
        updatedAt: new Date().toISOString(),
      },
    };
  });
  throw new CommandOutboxBlockedError(diagnostic);
}

export async function recoverCommandReceipt(
  profile: LocalProfile,
  relay: CommandRelay,
  codex: CommandCodex,
  profiles: CommandProfiles,
): Promise<CommandDelivery | null> {
  const current = await profiles.read();
  if (!current) return null;
  assertSameProfile(current, profile);
  const receipt = current.commandReceipt;
  if (!receipt) return null;
  if (receipt.phase === "blocked") {
    throw new CommandOutboxBlockedError(receiptDiagnostic(receipt));
  }
  if (receipt.phase === "submitted") {
    await acknowledgeReceipt(profiles, current, relay, receipt);
    return {
      messageId: receipt.messageId,
      submission: { status: "submitted", turnId: receipt.turnId },
      recovered: true,
    };
  }
  if (receipt.commandKind !== "codex_prompt") {
    return blockReceipt(
      profiles,
      current,
      receipt,
      `Command ${receipt.messageId} has an ambiguous stop submission; automatic retry is blocked`,
    );
  }

  if (!codex.findPeerPromptTurnIds) {
    return blockReceipt(
      profiles,
      current,
      receipt,
      `Command ${receipt.messageId} cannot be correlated by this Codex client; automatic retry is blocked`,
    );
  }

  const matches = await codex.findPeerPromptTurnIds(receipt.threadId, receipt.messageId);
  if (matches.length !== 1) {
    const matchSummary = matches.length === 0 ? "no matching turn" : `${matches.length} matching turns`;
    return blockReceipt(
      profiles,
      current,
      receipt,
      `Command ${receipt.messageId} recovery found ${matchSummary} in task ${receipt.threadId}; automatic retry is blocked`,
    );
  }
  const submitted = await persistSubmitted(profiles, current, receipt, matches[0]!);
  await acknowledgeReceipt(profiles, current, relay, submitted);
  return {
    messageId: receipt.messageId,
    submission: { status: "submitted", turnId: matches[0]! },
    recovered: true,
  };
}

export async function deliverCodexCommand(
  profile: LocalProfile,
  threadId: string,
  message: Message,
  relay: CommandRelay,
  codex: CommandCodex,
  profiles: CommandProfiles,
  admission?: CommandAdmission,
): Promise<CommandDelivery | null> {
  const attachments = message.kind === "codex_prompt"
    ? await Promise.all(message.attachments.map(async (attachment) => ({
        name: attachment.name,
        mediaType: attachment.mediaType,
        content: await relay.readMessageAttachment(
          profile.sessionId,
          profile.memberToken,
          message.id,
          attachment,
        ),
      })))
    : [];
  if (admission && !admission.isAllowed()) return null;
  const receipt = await persistIntent(profiles, profile, message, threadId);
  if (admission && !admission.isAllowed()) {
    await removeUnsubmittedIntent(profiles, profile, message.id);
    return null;
  }

  const submission = message.kind === "codex_stop"
    ? await codex.stopPeerPrompt({ threadId })
    : await codex.submitPeerPrompt({
        threadId,
        projectRoot: profile.projectRoot,
        commandId: message.id,
        requesterMemberId: message.senderMemberId,
        ownerMemberId: profile.memberId,
        peerDisplayName: message.senderDisplayName,
        body: message.body,
        attachments,
        codexOptions: message.codexOptions ?? DEFAULT_CODEX_PROMPT_OPTIONS,
      });
  if (submission.status !== "submitted") {
    await removeUnsubmittedIntent(profiles, profile, message.id);
    return null;
  }
  const submitted = await persistSubmitted(
    profiles,
    profile,
    receipt,
    submission.turnId ?? null,
  );
  await acknowledgeReceipt(profiles, profile, relay, submitted);
  return { messageId: message.id, submission, recovered: false };
}
