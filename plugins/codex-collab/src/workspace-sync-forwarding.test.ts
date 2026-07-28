import { describe, expect, it, vi } from "vitest";
import type { Message } from "@codex-collab/protocol";
import {
  forwardNextCodexPrompt,
  rejectUnapprovedQueuedCommands,
} from "./workspace-sync-service.js";
import { ownerPrompt, profile } from "./workspace-sync-test-fixtures.js";

describe("Codex prompt forwarding", () => {
  it("fails queued commands whose sender is no longer approved", async () => {
    const revokedPrompt = {
      ...ownerPrompt,
      senderMemberId: "editor-1",
      senderDisplayName: "Editor",
    };
    const updateMessageDeliveryStatus = vi.fn().mockResolvedValue(revokedPrompt);

    await expect(
      rejectUnapprovedQueuedCommands(
        profile,
        "thread-1",
        [revokedPrompt],
        [{
          id: "editor-1",
          sessionId: "session-1",
          displayName: "Editor",
          deviceLabel: null,
          role: "editor",
          status: "revoked",
          workspaceFileAccess: "workspace-write",
          createdAt: "2026-07-25T00:00:00.000Z",
          approvedAt: null,
        }],
        { updateMessageDeliveryStatus },
      ),
    ).resolves.toBe(1);

    expect(revokedPrompt.deliveryStatus).toBe("failed");
    expect(updateMessageDeliveryStatus).toHaveBeenCalledWith(
      "session-1",
      "member-token",
      "prompt-1",
      "failed",
      null,
    );
  });

  it("records a prompt only after the app-server accepts it", async () => {
    const listMessages = vi.fn().mockResolvedValue([ownerPrompt]);
    const readMessageAttachment = vi.fn();
    const updateMessageDeliveryStatus = vi.fn().mockResolvedValue(ownerPrompt);
    const submitPeerPrompt = vi.fn().mockResolvedValue({
      status: "submitted",
      turnId: "turn-1",
    });
    const stopPeerPrompt = vi.fn();
    const update = vi.fn().mockResolvedValue(profile);

    await expect(
      forwardNextCodexPrompt(
        profile,
        "thread-1",
        { listMessages, readMessageAttachment, updateMessageDeliveryStatus },
        { submitPeerPrompt, stopPeerPrompt },
        { update },
      ),
    ).resolves.toBe("prompt-1");

    expect(submitPeerPrompt).toHaveBeenCalledWith({
      threadId: "thread-1",
      projectRoot: "C:\\project",
      commandId: "prompt-1",
      requesterMemberId: "owner-1",
      ownerMemberId: "owner-1",
      peerDisplayName: "Owner",
      body: "Run the checks",
      attachments: [],
      codexOptions: {
        accessMode: "follow-desktop",
        customPermissions: null,
        model: null,
        reasoningEffort: "follow-desktop",
        speed: "follow-desktop",
        planMode: false,
      },
    });
    expect(update).toHaveBeenCalledWith({
      forwardedMessageIds: ["prompt-1"],
    });
    expect(updateMessageDeliveryStatus).toHaveBeenCalledWith(
      "session-1",
      "member-token",
      "prompt-1",
      "submitted",
      "turn-1",
    );
    expect(submitPeerPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]!,
    );
  });

  it("marks editor-authored prompts so the final Host boundary forces approval", async () => {
    const editorPrompt = {
      ...ownerPrompt,
      senderMemberId: "editor-1",
      senderDisplayName: "Editor",
    };
    const submitPeerPrompt = vi.fn().mockResolvedValue({
      status: "submitted",
      turnId: "turn-peer",
    });

    await forwardNextCodexPrompt(
      profile,
      "thread-1",
      {
        listMessages: vi.fn().mockResolvedValue([editorPrompt]),
        readMessageAttachment: vi.fn(),
        updateMessageDeliveryStatus: vi.fn().mockResolvedValue(editorPrompt),
      },
      { submitPeerPrompt, stopPeerPrompt: vi.fn() },
      { update: vi.fn().mockResolvedValue(profile) },
    );

    expect(submitPeerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterMemberId: "editor-1",
        ownerMemberId: "owner-1",
      }),
    );
  });

  it("leaves a prompt pending when app-server submission fails", async () => {
    const listMessages = vi.fn().mockResolvedValue([ownerPrompt]);
    const readMessageAttachment = vi.fn();
    const updateMessageDeliveryStatus = vi.fn();
    const submitPeerPrompt = vi.fn().mockRejectedValue(new Error("app-server failed"));
    const stopPeerPrompt = vi.fn();
    const update = vi.fn();

    await expect(
      forwardNextCodexPrompt(
        profile,
        "thread-1",
        { listMessages, readMessageAttachment, updateMessageDeliveryStatus },
        { submitPeerPrompt, stopPeerPrompt },
        { update },
      ),
    ).rejects.toThrow("app-server failed");

    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the prompt queued when the app-server cannot accept it", async () => {
    const listMessages = vi.fn().mockResolvedValue([ownerPrompt]);
    const readMessageAttachment = vi.fn();
    const updateMessageDeliveryStatus = vi.fn();
    const submitPeerPrompt = vi.fn().mockResolvedValue({
      status: "deferred",
      reason: "composer-not-empty",
    });
    const update = vi.fn();
    const stopPeerPrompt = vi.fn();

    await expect(
      forwardNextCodexPrompt(
        profile,
        "thread-1",
        { listMessages, readMessageAttachment, updateMessageDeliveryStatus },
        { submitPeerPrompt, stopPeerPrompt },
        { update },
      ),
    ).resolves.toBeNull();

    expect(update).not.toHaveBeenCalled();
  });

  it("records a newly started Desktop turn", async () => {
    const listMessages = vi.fn().mockResolvedValue([ownerPrompt]);
    const readMessageAttachment = vi.fn();
    const updateMessageDeliveryStatus = vi.fn();
    const submitPeerPrompt = vi.fn().mockResolvedValue({
      status: "submitted",
      mode: "started",
      turnId: "turn-1",
    });
    const stopPeerPrompt = vi.fn();
    const update = vi.fn().mockResolvedValue(profile);

    await expect(
      forwardNextCodexPrompt(
        profile,
        "thread-1",
        { listMessages, readMessageAttachment, updateMessageDeliveryStatus },
        { submitPeerPrompt, stopPeerPrompt },
        { update },
      ),
    ).resolves.toBe("prompt-1");

    expect(submitPeerPrompt).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      forwardedMessageIds: ["prompt-1"],
    });
  });

  it("keeps later prompts queued while a submitted command is running", async () => {
    const runningPrompt = {
      ...ownerPrompt,
      deliveryStatus: "submitted" as const,
      codexTurnId: "turn-1",
    };
    const queuedPrompt = {
      ...ownerPrompt,
      id: "prompt-2",
      body: "Run this next",
      createdAt: "2026-07-25T00:00:01.000Z",
    };
    const listMessages = vi.fn().mockResolvedValue([
      runningPrompt,
      queuedPrompt,
    ]);
    const readMessageAttachment = vi.fn();
    const updateMessageDeliveryStatus = vi.fn();
    const submitPeerPrompt = vi.fn();
    const stopPeerPrompt = vi.fn();
    const update = vi.fn();

    await expect(
      forwardNextCodexPrompt(
        profile,
        "thread-1",
        { listMessages, readMessageAttachment, updateMessageDeliveryStatus },
        { submitPeerPrompt, stopPeerPrompt },
        { update },
      ),
    ).resolves.toBeNull();

    expect(submitPeerPrompt).not.toHaveBeenCalled();
    expect(updateMessageDeliveryStatus).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("promotes the next queued prompt after the previous command completes", async () => {
    const completedPrompt = {
      ...ownerPrompt,
      deliveryStatus: "completed" as const,
      codexTurnId: "turn-1",
      completedAt: "2026-07-25T00:00:05.000Z",
    };
    const queuedPrompt = {
      ...ownerPrompt,
      id: "prompt-2",
      body: "Run this next",
      createdAt: "2026-07-25T00:00:01.000Z",
    };
    const listMessages = vi.fn().mockResolvedValue([
      completedPrompt,
      queuedPrompt,
    ]);
    const readMessageAttachment = vi.fn();
    const updateMessageDeliveryStatus = vi.fn().mockResolvedValue(queuedPrompt);
    const submitPeerPrompt = vi.fn().mockResolvedValue({
      status: "submitted",
      turnId: "turn-2",
    });
    const stopPeerPrompt = vi.fn();
    const update = vi.fn().mockResolvedValue(profile);

    await expect(
      forwardNextCodexPrompt(
        profile,
        "thread-1",
        { listMessages, readMessageAttachment, updateMessageDeliveryStatus },
        { submitPeerPrompt, stopPeerPrompt },
        { update },
      ),
    ).resolves.toBe("prompt-2");

    expect(submitPeerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: "prompt-2" }),
    );
    expect(updateMessageDeliveryStatus).toHaveBeenCalledWith(
      "session-1",
      "member-token",
      "prompt-2",
      "submitted",
      "turn-2",
    );
  });

  it("keeps the first web prompt queued while the Codex task is busy", async () => {
    const listMessages = vi.fn().mockResolvedValue([ownerPrompt]);
    const readMessageAttachment = vi.fn();
    const updateMessageDeliveryStatus = vi.fn();
    const submitPeerPrompt = vi.fn();
    const stopPeerPrompt = vi.fn();
    const update = vi.fn();

    await expect(
      forwardNextCodexPrompt(
        profile,
        "thread-1",
        { listMessages, readMessageAttachment, updateMessageDeliveryStatus },
        { submitPeerPrompt, stopPeerPrompt },
        { update },
        true,
      ),
    ).resolves.toBeNull();

    expect(submitPeerPrompt).not.toHaveBeenCalled();
    expect(updateMessageDeliveryStatus).not.toHaveBeenCalled();
  });

  it("lets a stop command bypass queued prompts while Codex is busy", async () => {
    const queuedPrompt = {
      ...ownerPrompt,
      id: "prompt-2",
      body: "Run this next",
    };
    const stopMessage = {
      ...ownerPrompt,
      id: "stop-1",
      kind: "codex_stop" as const,
      body: "Stop",
      createdAt: "2026-07-25T00:00:01.000Z",
    };
    const listMessages = vi.fn().mockResolvedValue([
      queuedPrompt,
      stopMessage,
    ]);
    const readMessageAttachment = vi.fn();
    const updateMessageDeliveryStatus = vi.fn();
    const submitPeerPrompt = vi.fn();
    const stopPeerPrompt = vi.fn().mockResolvedValue({
      status: "submitted",
      turnId: "turn-1",
    });
    const update = vi.fn().mockResolvedValue(profile);

    await expect(
      forwardNextCodexPrompt(
        profile,
        "thread-1",
        { listMessages, readMessageAttachment, updateMessageDeliveryStatus },
        { submitPeerPrompt, stopPeerPrompt },
        { update },
        true,
      ),
    ).resolves.toBe("stop-1");

    expect(stopPeerPrompt).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(submitPeerPrompt).not.toHaveBeenCalled();
    expect(updateMessageDeliveryStatus).toHaveBeenCalledWith(
      "session-1",
      "member-token",
      "stop-1",
      "submitted",
      "turn-1",
    );
  });

  it("lets an editor stop preempt an already submitted prompt and queued follow-ups", async () => {
    const runningPrompt = {
      ...ownerPrompt,
      deliveryStatus: "submitted" as const,
      codexTurnId: "turn-1",
    };
    const queuedPrompt = {
      ...ownerPrompt,
      id: "prompt-2",
      body: "Run this next",
      createdAt: "2026-07-25T00:00:01.000Z",
    };
    const editorStop = {
      ...ownerPrompt,
      id: "stop-editor",
      senderMemberId: "editor-1",
      senderDisplayName: "Editor",
      kind: "codex_stop" as const,
      body: "Stop",
      createdAt: "2026-07-25T00:00:02.000Z",
    };
    const listMessages = vi.fn().mockResolvedValue([
      runningPrompt,
      queuedPrompt,
      editorStop,
    ]);
    const updateMessageDeliveryStatus = vi.fn();
    const stopPeerPrompt = vi.fn().mockResolvedValue({
      status: "submitted",
      turnId: "turn-1",
    });
    const update = vi.fn().mockResolvedValue(profile);

    await expect(
      forwardNextCodexPrompt(
        profile,
        "thread-1",
        {
          listMessages,
          readMessageAttachment: vi.fn(),
          updateMessageDeliveryStatus,
        },
        { submitPeerPrompt: vi.fn(), stopPeerPrompt },
        { update },
        true,
      ),
    ).resolves.toBe("stop-editor");

    expect(stopPeerPrompt).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(updateMessageDeliveryStatus).toHaveBeenCalledWith(
      "session-1",
      "member-token",
      "stop-editor",
      "submitted",
      "turn-1",
    );
  });

  it("downloads attachments before direct app-server submission", async () => {
    const attachmentPrompt = {
      ...ownerPrompt,
      attachments: [
        {
          id: "attachment-1",
          name: "diagram.png",
          mediaType: "image/png",
          size: 3,
        },
      ],
      codexOptions: {
        accessMode: "full-access" as const,
        customPermissions: null,
        model: "gpt-5.6-sol",
        reasoningEffort: "high" as const,
        speed: "standard" as const,
        planMode: true,
      },
    };
    const listMessages = vi.fn().mockResolvedValue([attachmentPrompt]);
    const readMessageAttachment = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const updateMessageDeliveryStatus = vi.fn().mockResolvedValue(attachmentPrompt);
    const submitPeerPrompt = vi.fn().mockResolvedValue({
      status: "submitted",
      turnId: "turn-attachment",
    });
    const stopPeerPrompt = vi.fn();
    const update = vi.fn().mockResolvedValue(profile);

    await forwardNextCodexPrompt(
      profile,
      "thread-1",
      { listMessages, readMessageAttachment, updateMessageDeliveryStatus },
      { submitPeerPrompt, stopPeerPrompt },
      { update },
    );

    expect(readMessageAttachment).toHaveBeenCalledWith(
      "session-1",
      "member-token",
      "prompt-1",
      attachmentPrompt.attachments[0],
    );
    expect(submitPeerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "C:\\project",
        commandId: "prompt-1",
        attachments: [
          {
            name: "diagram.png",
            mediaType: "image/png",
            content: new Uint8Array([1, 2, 3]),
          },
        ],
        codexOptions: attachmentPrompt.codexOptions,
      }),
    );
  });

  it("does not submit after admission closes while reading an attachment", async () => {
    let releaseAttachment!: () => void;
    const attachmentReady = new Promise<Uint8Array>((resolve) => {
      releaseAttachment = () => resolve(new Uint8Array([1, 2, 3]));
    });
    const attachmentPrompt = {
      ...ownerPrompt,
      attachments: [{
        id: "attachment-1", name: "diagram.png", mediaType: "image/png", size: 3,
      }],
    };
    let allowed = true;
    const readMessageAttachment = vi.fn().mockReturnValue(attachmentReady);
    const submitPeerPrompt = vi.fn();
    const forwarding = forwardNextCodexPrompt(
      profile,
      "thread-1",
      {
        listMessages: vi.fn().mockResolvedValue([attachmentPrompt]),
        readMessageAttachment,
        updateMessageDeliveryStatus: vi.fn(),
      },
      { submitPeerPrompt, stopPeerPrompt: vi.fn() },
      { update: vi.fn() },
      false,
      undefined,
      { isAllowed: () => allowed },
    );
    await vi.waitFor(() => expect(readMessageAttachment).toHaveBeenCalledTimes(1));
    allowed = false;
    releaseAttachment();

    await expect(forwarding).resolves.toBeNull();
    expect(submitPeerPrompt).not.toHaveBeenCalled();
  });

  it("does not stop a turn after admission closes while loading commands", async () => {
    let releaseMessages!: (messages: Message[]) => void;
    const messagesReady = new Promise<Message[]>((resolve) => {
      releaseMessages = resolve;
    });
    const stopMessage = { ...ownerPrompt, id: "stop-closed", kind: "codex_stop" as const };
    let allowed = true;
    const listMessages = vi.fn().mockReturnValue(messagesReady);
    const stopPeerPrompt = vi.fn();
    const forwarding = forwardNextCodexPrompt(
      profile,
      "thread-1",
      { listMessages, readMessageAttachment: vi.fn(), updateMessageDeliveryStatus: vi.fn() },
      { submitPeerPrompt: vi.fn(), stopPeerPrompt },
      { update: vi.fn() },
      false,
      undefined,
      { isAllowed: () => allowed },
    );
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(1));
    allowed = false;
    releaseMessages([stopMessage]);

    await expect(forwarding).resolves.toBeNull();
    expect(stopPeerPrompt).not.toHaveBeenCalled();
  });

  it("forwards a stop request even while the selected task is active", async () => {
    const stopMessage = {
      ...ownerPrompt,
      id: "stop-1",
      kind: "codex_stop" as const,
      body: "Stop",
    };
    const listMessages = vi.fn().mockResolvedValue([stopMessage]);
    const readMessageAttachment = vi.fn();
    const updateMessageDeliveryStatus = vi.fn().mockResolvedValue(stopMessage);
    const submitPeerPrompt = vi.fn();
    const stopPeerPrompt = vi.fn().mockResolvedValue({ status: "submitted" });
    const update = vi.fn().mockResolvedValue(profile);

    await expect(
      forwardNextCodexPrompt(
        profile,
        "thread-1",
        { listMessages, readMessageAttachment, updateMessageDeliveryStatus },
        { submitPeerPrompt, stopPeerPrompt },
        { update },
      ),
    ).resolves.toBe("stop-1");

    expect(stopPeerPrompt).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
    expect(submitPeerPrompt).not.toHaveBeenCalled();
  });
});
