import { describe, expect, it, vi } from "vitest";
import type { LocalProfile } from "./local-profile.js";
import {
  forwardNextCodexPrompt,
  reconcileCodexCommandStatuses,
} from "./workspace-sync-service.js";

const profile: LocalProfile = {
  relayUrl: "https://relay.example.com",
  sessionId: "session-1",
  memberId: "owner-1",
  displayName: "Owner",
  role: "owner",
  memberToken: "member-token",
  projectRoot: "C:\\project",
  forwardedMessageIds: [],
};

const ownerPrompt = {
  id: "prompt-1",
  sessionId: "session-1",
  senderMemberId: "owner-1",
  senderDisplayName: "Owner",
  kind: "codex_prompt" as const,
  body: "Run the checks",
  attachments: [],
  codexOptions: null,
  deliveryStatus: "queued" as const,
  codexTurnId: null,
  completedAt: null,
  createdAt: "2026-07-25T00:00:00.000Z",
};

describe("Codex prompt forwarding", () => {
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
      peerDisplayName: "Owner",
      body: "Run the checks",
      attachments: [],
      codexOptions: {
        accessMode: "follow-desktop",
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

  it("records the submission mode returned by the desktop bridge", async () => {
    const listMessages = vi.fn().mockResolvedValue([ownerPrompt]);
    const readMessageAttachment = vi.fn();
    const updateMessageDeliveryStatus = vi.fn();
    const submitPeerPrompt = vi.fn().mockResolvedValue({
      status: "submitted",
      mode: "steered",
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

describe("Codex prompt completion", () => {
  it("marks a submitted command complete only after its Codex turn completes", async () => {
    const submittedPrompt = {
      ...ownerPrompt,
      deliveryStatus: "submitted" as const,
      codexTurnId: "turn-1",
    };
    const listMessages = vi.fn().mockResolvedValue([submittedPrompt]);
    const updateMessageDeliveryStatus = vi.fn().mockResolvedValue(submittedPrompt);
    const getTurnStatus = vi.fn().mockResolvedValue("completed");

    await expect(
      reconcileCodexCommandStatuses(
        profile,
        "thread-1",
        { listMessages, updateMessageDeliveryStatus },
        { getTurnStatus },
      ),
    ).resolves.toBe(1);

    expect(updateMessageDeliveryStatus).toHaveBeenCalledWith(
      "session-1",
      "member-token",
      "prompt-1",
      "completed",
      "turn-1",
    );
  });

  it("keeps a submitted command running while its Codex turn is active", async () => {
    const listMessages = vi.fn().mockResolvedValue([
      {
        ...ownerPrompt,
        deliveryStatus: "submitted",
        codexTurnId: "turn-1",
      },
    ]);
    const updateMessageDeliveryStatus = vi.fn();
    const getTurnStatus = vi.fn().mockResolvedValue("inProgress");

    await expect(
      reconcileCodexCommandStatuses(
        profile,
        "thread-1",
        { listMessages, updateMessageDeliveryStatus },
        { getTurnStatus },
      ),
    ).resolves.toBe(0);
    expect(updateMessageDeliveryStatus).not.toHaveBeenCalled();
  });

  it("ignores a transient interrupted status for the active submitted command", async () => {
    const listMessages = vi.fn().mockResolvedValue([
      {
        ...ownerPrompt,
        deliveryStatus: "submitted",
        codexTurnId: "turn-1",
      },
    ]);
    const updateMessageDeliveryStatus = vi.fn();
    const getTurnStatus = vi.fn().mockResolvedValue("interrupted");

    await expect(
      reconcileCodexCommandStatuses(
        profile,
        "thread-1",
        { listMessages, updateMessageDeliveryStatus },
        { getTurnStatus },
        true,
      ),
    ).resolves.toBe(0);

    expect(updateMessageDeliveryStatus).not.toHaveBeenCalled();
  });

  it("ignores a transient failed status for the active submitted command", async () => {
    const listMessages = vi.fn().mockResolvedValue([
      {
        ...ownerPrompt,
        deliveryStatus: "submitted",
        codexTurnId: "turn-1",
      },
    ]);
    const updateMessageDeliveryStatus = vi.fn();

    await expect(
      reconcileCodexCommandStatuses(
        profile,
        "thread-1",
        { listMessages, updateMessageDeliveryStatus },
        { getTurnStatus: vi.fn().mockResolvedValue("failed") },
        true,
      ),
    ).resolves.toBe(0);

    expect(updateMessageDeliveryStatus).not.toHaveBeenCalled();
  });

  it("converges an interrupted prompt and its stop while rollout activity is still busy", async () => {
    const submittedPrompt = {
      ...ownerPrompt,
      deliveryStatus: "submitted" as const,
      codexTurnId: "turn-1",
    };
    const submittedStop = {
      ...ownerPrompt,
      id: "stop-1",
      kind: "codex_stop" as const,
      body: "Stop",
      deliveryStatus: "submitted" as const,
      codexTurnId: "turn-1",
      createdAt: "2026-07-25T00:00:01.000Z",
    };
    const updateMessageDeliveryStatus = vi.fn();
    const getTurnStatus = vi.fn().mockResolvedValue("interrupted");

    await expect(
      reconcileCodexCommandStatuses(
        profile,
        "thread-1",
        {
          listMessages: vi.fn().mockResolvedValue([
            submittedPrompt,
            submittedStop,
          ]),
          updateMessageDeliveryStatus,
        },
        { getTurnStatus },
        true,
      ),
    ).resolves.toBe(2);

    expect(getTurnStatus).toHaveBeenCalledTimes(1);
    expect(updateMessageDeliveryStatus).toHaveBeenNthCalledWith(
      1,
      "session-1",
      "member-token",
      "prompt-1",
      "failed",
      "turn-1",
    );
    expect(updateMessageDeliveryStatus).toHaveBeenNthCalledWith(
      2,
      "session-1",
      "member-token",
      "stop-1",
      "completed",
      "turn-1",
    );
  });

  it("marks both the prompt and stop failed when the target turn fails", async () => {
    const submittedPrompt = {
      ...ownerPrompt,
      deliveryStatus: "submitted" as const,
      codexTurnId: "turn-1",
    };
    const submittedStop = {
      ...ownerPrompt,
      id: "stop-1",
      kind: "codex_stop" as const,
      body: "Stop",
      deliveryStatus: "submitted" as const,
      codexTurnId: "turn-1",
      createdAt: "2026-07-25T00:00:01.000Z",
    };
    const updateMessageDeliveryStatus = vi.fn();

    await expect(
      reconcileCodexCommandStatuses(
        profile,
        "thread-1",
        {
          listMessages: vi.fn().mockResolvedValue([
            submittedPrompt,
            submittedStop,
          ]),
          updateMessageDeliveryStatus,
        },
        { getTurnStatus: vi.fn().mockResolvedValue("failed") },
        true,
      ),
    ).resolves.toBe(2);

    expect(updateMessageDeliveryStatus).toHaveBeenNthCalledWith(
      1,
      "session-1",
      "member-token",
      "prompt-1",
      "failed",
      "turn-1",
    );
    expect(updateMessageDeliveryStatus).toHaveBeenNthCalledWith(
      2,
      "session-1",
      "member-token",
      "stop-1",
      "failed",
      "turn-1",
    );
  });

  it("fails a stopped prompt when Desktop IPC turn status is unavailable", async () => {
    const submittedPrompt = {
      ...ownerPrompt,
      deliveryStatus: "submitted" as const,
      codexTurnId: "turn-desktop",
    };
    const submittedStop = {
      ...ownerPrompt,
      id: "stop-1",
      kind: "codex_stop" as const,
      body: "Stop",
      deliveryStatus: "submitted" as const,
      codexTurnId: "turn-desktop",
      createdAt: "2026-07-25T00:00:01.000Z",
    };
    const updateMessageDeliveryStatus = vi.fn();

    await expect(
      reconcileCodexCommandStatuses(
        profile,
        "thread-1",
        {
          listMessages: vi.fn().mockResolvedValue([
            submittedPrompt,
            submittedStop,
          ]),
          updateMessageDeliveryStatus,
        },
        { getTurnStatus: vi.fn().mockResolvedValue(null) },
        true,
      ),
    ).resolves.toBe(1);

    expect(updateMessageDeliveryStatus).toHaveBeenCalledOnce();
    expect(updateMessageDeliveryStatus).toHaveBeenCalledWith(
      "session-1",
      "member-token",
      "prompt-1",
      "failed",
      "turn-desktop",
    );
  });

  it("completes a Desktop stop with unavailable turn status after runtime becomes idle", async () => {
    const submittedPrompt = {
      ...ownerPrompt,
      deliveryStatus: "submitted" as const,
      codexTurnId: "turn-desktop",
    };
    const submittedStop = {
      ...ownerPrompt,
      id: "stop-1",
      kind: "codex_stop" as const,
      body: "Stop",
      deliveryStatus: "submitted" as const,
      codexTurnId: "turn-desktop",
      createdAt: "2026-07-25T00:00:01.000Z",
    };
    const updateMessageDeliveryStatus = vi.fn();

    await expect(
      reconcileCodexCommandStatuses(
        profile,
        "thread-1",
        {
          listMessages: vi.fn().mockResolvedValue([
            submittedPrompt,
            submittedStop,
          ]),
          updateMessageDeliveryStatus,
        },
        { getTurnStatus: vi.fn().mockResolvedValue(null) },
        false,
      ),
    ).resolves.toBe(2);

    expect(updateMessageDeliveryStatus).toHaveBeenNthCalledWith(
      1,
      "session-1",
      "member-token",
      "prompt-1",
      "failed",
      "turn-desktop",
    );
    expect(updateMessageDeliveryStatus).toHaveBeenNthCalledWith(
      2,
      "session-1",
      "member-token",
      "stop-1",
      "completed",
      "turn-desktop",
    );
  });

  it("keeps an ordinary null-status prompt submitted while runtime is busy", async () => {
    const updateMessageDeliveryStatus = vi.fn();

    await expect(
      reconcileCodexCommandStatuses(
        profile,
        "thread-1",
        {
          listMessages: vi.fn().mockResolvedValue([
            {
              ...ownerPrompt,
              deliveryStatus: "submitted",
              codexTurnId: "turn-1",
            },
          ]),
          updateMessageDeliveryStatus,
        },
        { getTurnStatus: vi.fn().mockResolvedValue(null) },
        true,
      ),
    ).resolves.toBe(0);

    expect(updateMessageDeliveryStatus).not.toHaveBeenCalled();
  });

  it("completes a submitted command without a turn id after the task becomes idle", async () => {
    const submittedPrompt = {
      ...ownerPrompt,
      deliveryStatus: "submitted" as const,
      codexTurnId: null,
    };
    const listMessages = vi.fn().mockResolvedValue([submittedPrompt]);
    const updateMessageDeliveryStatus = vi.fn().mockResolvedValue(submittedPrompt);
    const getTurnStatus = vi.fn().mockResolvedValue(null);

    await expect(
      reconcileCodexCommandStatuses(
        profile,
        "thread-1",
        { listMessages, updateMessageDeliveryStatus },
        { getTurnStatus },
        false,
      ),
    ).resolves.toBe(1);

    expect(updateMessageDeliveryStatus).toHaveBeenCalledWith(
      "session-1",
      "member-token",
      "prompt-1",
      "completed",
      null,
    );
    expect(getTurnStatus).not.toHaveBeenCalled();
  });

  it("collapses legacy duplicate submitted commands to one active item", async () => {
    const firstPrompt = {
      ...ownerPrompt,
      deliveryStatus: "submitted" as const,
      codexTurnId: "turn-old",
    };
    const latestPrompt = {
      ...ownerPrompt,
      id: "prompt-2",
      deliveryStatus: "submitted" as const,
      codexTurnId: "turn-current",
      createdAt: "2026-07-25T00:00:01.000Z",
    };
    const listMessages = vi.fn().mockResolvedValue([
      firstPrompt,
      latestPrompt,
    ]);
    const updateMessageDeliveryStatus = vi.fn().mockResolvedValue(firstPrompt);
    const getTurnStatus = vi.fn().mockResolvedValue(null);

    await expect(
      reconcileCodexCommandStatuses(
        profile,
        "thread-1",
        { listMessages, updateMessageDeliveryStatus },
        { getTurnStatus },
        true,
      ),
    ).resolves.toBe(1);

    expect(updateMessageDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(updateMessageDeliveryStatus).toHaveBeenCalledWith(
      "session-1",
      "member-token",
      "prompt-1",
      "completed",
      "turn-old",
    );
  });
});
