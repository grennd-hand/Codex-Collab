import { describe, expect, it, vi } from "vitest";
import { reconcileCodexCommandStatuses } from "./workspace-sync-service.js";
import { ownerPrompt, profile } from "./workspace-sync-test-fixtures.js";

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
