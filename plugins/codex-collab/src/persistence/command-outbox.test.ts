import { describe, expect, it, vi } from "vitest";
import type { LocalProfile } from "./local-profile.js";
import {
  CommandOutboxBlockedError,
  deliverCodexCommand,
  recoverCommandReceipt,
} from "./command-outbox.js";
import { ownerPrompt, profile } from "../sync/workspace-sync-test-fixtures.js";

function memoryProfiles(initial: LocalProfile) {
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

function submittedProfile(phase: "submitting" | "submitted" = "submitted"): LocalProfile {
  return {
    ...profile,
    commandReceipt: {
      messageId: ownerPrompt.id,
      threadId: "thread-1",
      commandKind: "codex_prompt",
      phase,
      turnId: phase === "submitted" ? "turn-1" : null,
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:01.000Z",
    },
  };
}

function relay(updateMessageDeliveryStatus = vi.fn().mockResolvedValue(ownerPrompt)) {
  return {
    readMessageAttachment: vi.fn(),
    updateMessageDeliveryStatus,
  };
}

function codex(findPeerPromptTurnIds?: ReturnType<typeof vi.fn>) {
  return {
    submitPeerPrompt: vi.fn(),
    stopPeerPrompt: vi.fn(),
    ...(findPeerPromptTurnIds ? { findPeerPromptTurnIds } : {}),
  };
}

describe("durable Codex command outbox", () => {
  it("replays only the Relay acknowledgement for a submitted receipt", async () => {
    const profiles = memoryProfiles(submittedProfile());
    const relayClient = relay();
    const codexClient = codex();

    await expect(
      recoverCommandReceipt(profile, relayClient, codexClient, profiles),
    ).resolves.toMatchObject({
      messageId: "prompt-1",
      recovered: true,
      submission: { status: "submitted", turnId: "turn-1" },
    });

    expect(codexClient.submitPeerPrompt).not.toHaveBeenCalled();
    expect(relayClient.updateMessageDeliveryStatus).toHaveBeenCalledWith(
      "session-1",
      "member-token",
      "prompt-1",
      "submitted",
      "turn-1",
    );
    expect(profiles.snapshot()).toMatchObject({ forwardedMessageIds: ["prompt-1"] });
    expect(profiles.snapshot().commandReceipt).toBeUndefined();
  });

  it("recovers the crash window after Codex submission without submitting twice", async () => {
    const profiles = memoryProfiles(profile);
    const updateMessageDeliveryStatus = vi.fn()
      .mockRejectedValueOnce(new Error("relay unavailable"))
      .mockResolvedValueOnce(ownerPrompt);
    const relayClient = relay(updateMessageDeliveryStatus);
    const codexClient = {
      ...codex(),
      submitPeerPrompt: vi.fn().mockResolvedValue({
        status: "submitted",
        turnId: "turn-crash",
      }),
    };

    await expect(
      deliverCodexCommand(
        profile,
        "thread-1",
        ownerPrompt,
        relayClient,
        codexClient,
        profiles,
      ),
    ).rejects.toThrow("relay unavailable");
    expect(profiles.snapshot().commandReceipt).toMatchObject({
      phase: "submitted",
      turnId: "turn-crash",
    });

    await expect(
      recoverCommandReceipt(profile, relayClient, codexClient, profiles),
    ).resolves.toMatchObject({ recovered: true });
    expect(codexClient.submitPeerPrompt).toHaveBeenCalledTimes(1);
    expect(updateMessageDeliveryStatus).toHaveBeenCalledTimes(2);
    expect(profiles.snapshot().commandReceipt).toBeUndefined();
  });

  it("correlates one submitting receipt and acknowledges it without retrying Codex", async () => {
    const profiles = memoryProfiles(submittedProfile("submitting"));
    const findPeerPromptTurnIds = vi.fn().mockResolvedValue(["turn-found"]);
    const relayClient = relay();
    const codexClient = codex(findPeerPromptTurnIds);

    await expect(
      recoverCommandReceipt(profile, relayClient, codexClient, profiles),
    ).resolves.toMatchObject({
      recovered: true,
      submission: { turnId: "turn-found" },
    });
    expect(findPeerPromptTurnIds).toHaveBeenCalledWith("thread-1", "prompt-1");
    expect(codexClient.submitPeerPrompt).not.toHaveBeenCalled();
    expect(profiles.snapshot().commandReceipt).toBeUndefined();
  });

  it.each([
    ["zero", []],
    ["multiple", ["turn-1", "turn-2"]],
  ])("blocks %s correlation matches without an automatic retry", async (_label, matches) => {
    const profiles = memoryProfiles(submittedProfile("submitting"));
    const findPeerPromptTurnIds = vi.fn().mockResolvedValue(matches);
    const relayClient = relay();
    const codexClient = codex(findPeerPromptTurnIds);

    await expect(
      recoverCommandReceipt(profile, relayClient, codexClient, profiles),
    ).rejects.toBeInstanceOf(CommandOutboxBlockedError);
    expect(profiles.snapshot().commandReceipt).toMatchObject({ phase: "blocked" });
    await expect(
      recoverCommandReceipt(profile, relayClient, codexClient, profiles),
    ).rejects.toBeInstanceOf(CommandOutboxBlockedError);
    expect(findPeerPromptTurnIds).toHaveBeenCalledTimes(1);
    expect(codexClient.submitPeerPrompt).not.toHaveBeenCalled();
    expect(relayClient.updateMessageDeliveryStatus).not.toHaveBeenCalled();
  });

  it("fails closed when a room is re-paired to another project root", async () => {
    const profiles = memoryProfiles({
      ...submittedProfile(),
      projectRoot: "C:\\different-project",
    });
    const relayClient = relay();

    await expect(
      recoverCommandReceipt(profile, relayClient, codex(), profiles),
    ).rejects.toThrow("profile changed");
    expect(relayClient.updateMessageDeliveryStatus).not.toHaveBeenCalled();
  });
});
