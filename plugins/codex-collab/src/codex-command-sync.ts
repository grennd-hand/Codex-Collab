import { DEFAULT_CODEX_PROMPT_OPTIONS, type Message } from "@codex-collab/protocol";
import type { CodexAppServerClient } from "./app-server-client.js";
import type { LocalProfile, LocalProfileStore } from "./local-profile.js";
import type { RelayClient } from "./relay-client.js";
import { nextPendingCodexCommand } from "./workspace-sync.js";

export function hasInFlightCodexCommand(messages: readonly Message[]): boolean {
  return messages.some(
    (message) =>
      (message.kind === "codex_prompt" || message.kind === "codex_stop") &&
      (message.deliveryStatus === "queued" || message.deliveryStatus === "submitted"),
  );
}

export async function forwardNextCodexPrompt(
  profile: LocalProfile,
  threadId: string,
  relay: Pick<
    RelayClient,
    "listMessages" | "readMessageAttachment" | "updateMessageDeliveryStatus"
  >,
  codex: Pick<
    CodexAppServerClient,
    "submitPeerPrompt" | "stopPeerPrompt"
  >,
  profiles: Pick<LocalProfileStore, "update">,
  threadBusy = false,
  prefetchedMessages?: Message[],
): Promise<string | null> {
  const messages =
    prefetchedMessages ??
    (await relay.listMessages(profile.sessionId, profile.memberToken));
  const threadMessages = messages.filter(
    (message) =>
      message.kind !== "codex_prompt" && message.kind !== "codex_stop"
        ? true
        : message.workspaceThreadId === threadId,
  );
  const forwardedMessageIds = profile.forwardedMessageIds ?? [];
  const pendingCommand = nextPendingCodexCommand(
    threadMessages,
    forwardedMessageIds,
  );
  if (!pendingCommand) {
    return null;
  }
  const forwarded = new Set(forwardedMessageIds);
  const submittedCommand = threadMessages.some(
    (message) =>
      (message.kind === "codex_prompt" || message.kind === "codex_stop") &&
      message.deliveryStatus === "submitted",
  );
  const pendingStop = threadMessages.find(
    (message) =>
      message.kind === "codex_stop" &&
      message.deliveryStatus === "queued" &&
      !forwarded.has(message.id),
  );
  const pendingPrompt =
    threadBusy || submittedCommand
      ? pendingStop ?? null
      : pendingCommand;
  if (!pendingPrompt) return null;

  const submission =
    pendingPrompt.kind === "codex_stop"
      ? await codex.stopPeerPrompt({ threadId })
      : await codex.submitPeerPrompt({
          threadId,
          projectRoot: profile.projectRoot,
          commandId: pendingPrompt.id,
          peerDisplayName: pendingPrompt.senderDisplayName,
          body: pendingPrompt.body,
          attachments: await Promise.all(
            pendingPrompt.attachments.map(async (attachment) => ({
              name: attachment.name,
              mediaType: attachment.mediaType,
              content: await relay.readMessageAttachment(
                profile.sessionId,
                profile.memberToken,
                pendingPrompt.id,
                attachment,
              ),
            })),
          ),
          codexOptions: pendingPrompt.codexOptions ?? DEFAULT_CODEX_PROMPT_OPTIONS,
        });
  if (submission.status !== "submitted") {
    return null;
  }
  await profiles.update({
    forwardedMessageIds: [
      ...(profile.forwardedMessageIds ?? []),
      pendingPrompt.id,
    ],
  });
  await relay.updateMessageDeliveryStatus(
    profile.sessionId,
    profile.memberToken,
    pendingPrompt.id,
    "submitted",
    submission.turnId ?? null,
  );
  return pendingPrompt.id;
}

export async function reconcileCodexCommandStatuses(
  profile: LocalProfile,
  threadId: string,
  relay: Pick<RelayClient, "listMessages" | "updateMessageDeliveryStatus">,
  codex: Pick<CodexAppServerClient, "getTurnStatus">,
  threadBusy = true,
  prefetchedMessages?: Message[],
): Promise<number> {
  const messages =
    prefetchedMessages ??
    (await relay.listMessages(profile.sessionId, profile.memberToken));
  const threadMessages = messages.filter(
    (message) =>
      message.kind !== "codex_prompt" && message.kind !== "codex_stop"
        ? true
        : message.workspaceThreadId === threadId,
  );
  const tracked = threadMessages.filter(
    (message) =>
      (message.kind === "codex_prompt" || message.kind === "codex_stop") &&
      message.deliveryStatus === "submitted",
  );
  const statuses = new Map<string, Awaited<ReturnType<CodexAppServerClient["getTurnStatus"]>>>();
  const latestTrackedId = tracked.at(-1)?.id ?? null;
  const latestTrackedPromptId =
    tracked.findLast((message) => message.kind === "codex_prompt")?.id ?? null;
  const stoppedTurnIds = new Set(
    threadMessages
      .filter(
        (message) =>
          message.kind === "codex_stop" &&
          message.codexTurnId &&
          (message.deliveryStatus === "submitted" ||
            message.deliveryStatus === "completed"),
      )
      .map((message) => message.codexTurnId as string),
  );
  let updated = 0;

  for (const message of tracked) {
    const turnId = message.codexTurnId;
    let status = turnId ? statuses.get(turnId) : null;
    if (turnId && status === undefined) {
      status = await codex.getTurnStatus(threadId, turnId);
      statuses.set(turnId, status);
    }
    let deliveryStatus: "completed" | "failed" | null = null;
    if (status === "completed") {
      deliveryStatus = "completed";
    } else if (message.kind === "codex_stop") {
      if (status === "interrupted") {
        deliveryStatus = "completed";
      } else if (status === "failed") {
        deliveryStatus = "failed";
      }
    } else if (
      (status === "failed" || status === "interrupted") &&
      (!threadBusy ||
        message.id !== latestTrackedPromptId ||
        (turnId !== null && stoppedTurnIds.has(turnId)))
    ) {
      deliveryStatus = "failed";
    } else if (
      status === null &&
      message.kind === "codex_prompt" &&
      turnId !== null &&
      stoppedTurnIds.has(turnId)
    ) {
      deliveryStatus = "failed";
    }
    if (
      !deliveryStatus &&
      status === null &&
      (!threadBusy ||
        (tracked.length > 1 && message.id !== latestTrackedId))
    ) {
      deliveryStatus = "completed";
    }
    if (!deliveryStatus) continue;
    await relay.updateMessageDeliveryStatus(
      profile.sessionId,
      profile.memberToken,
      message.id,
      deliveryStatus,
      turnId ?? null,
    );
    message.deliveryStatus = deliveryStatus;
    updated += 1;
  }

  return updated;
}

