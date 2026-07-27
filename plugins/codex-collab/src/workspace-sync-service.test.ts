import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceSummary, WorkspaceSyncState } from "@codex-collab/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalProfile } from "./local-profile.js";
import { RelayClient } from "./relay-client.js";
import {
  forwardNextCodexPrompt,
  reconcileCodexCommandStatuses,
  WorkspaceSyncService,
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
  observedThreadIds: ["thread-1"],
  threadCatalogVersion: 1,
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
  workspaceThreadId: "thread-1",
  completedAt: null,
  createdAt: "2026-07-25T00:00:00.000Z",
};

function syncState(workspace: WorkspaceSummary): WorkspaceSyncState {
  const { history, files, ...state } = workspace;
  return {
    ...state,
    historyCount: history.length,
    fileCount: files.length,
  };
}

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

describe("workspace live history sync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes running history without rebuilding the file snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-live-sync-"));
    const rolloutPath = join(directory, "rollout-thread-1.jsonl");
    await writeFile(rolloutPath, "{}\n", "utf8");
    const liveHistory = [
      {
        id: "call-1",
        role: "command" as const,
        text: "tool: exec_command\nstatus: running\ninput:\nnpm test",
        createdAt: "2026-07-25T00:00:01.000Z",
      },
    ];
    const workspace = {
      hostConnected: true,
      hostDeviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [
        {
          id: "thread-1",
          name: "Live task",
          preview: "",
          updatedAt: 1,
        },
      ],
      selectedThreadId: "thread-1",
      selectedThread: {
        id: "thread-1",
        name: "Live task",
        preview: "",
        updatedAt: 1,
      },
      history: [],
      files: [
        {
          path: "README.md",
          size: 7,
          modifiedAt: "2026-07-25T00:00:00.000Z",
          sha256: "a".repeat(64),
        },
      ],
      codexRuntimeStatus: "running" as const,
      syncedAt: "2026-07-25T00:00:00.000Z",
    };
    const listMessages = vi
      .spyOn(RelayClient.prototype, "listMessages")
      .mockResolvedValue([]);
    vi.spyOn(RelayClient.prototype, "getWorkspaceSyncState")
      .mockResolvedValueOnce(syncState(workspace))
      .mockResolvedValue(syncState({
        ...workspace,
        history: liveHistory,
        syncedAt: "2026-07-25T00:00:02.000Z",
      }));
    const publishRuntimeStatus = vi
      .spyOn(RelayClient.prototype, "publishCodexRuntimeStatus")
      .mockResolvedValue(syncState(workspace));
    const publishHistory = vi
      .spyOn(RelayClient.prototype, "publishWorkspaceHistory")
      .mockResolvedValue(syncState({
        ...workspace,
        history: liveHistory,
        syncedAt: "2026-07-25T00:00:02.000Z",
      }));
    const publishSnapshot = vi
      .spyOn(RelayClient.prototype, "publishWorkspaceSnapshot")
      .mockResolvedValue(syncState({
        ...workspace,
        history: liveHistory,
        syncedAt: "2026-07-25T00:00:03.000Z",
      }));
    const profiles = {
      read: vi.fn().mockResolvedValue({ ...profile, projectRoot: directory }),
      update: vi.fn().mockResolvedValue(profile),
    };
    const codex = {
      listThreads: vi.fn().mockResolvedValue([
        {
          id: "thread-1",
          name: "Live task",
          preview: "",
          updatedAt: 1,
          path: rolloutPath,
        },
      ]),
      isThreadBusyForPrompt: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false),
      readThreadHistory: vi.fn().mockResolvedValue(liveHistory),
      getTurnStatus: vi.fn(),
      submitPeerPrompt: vi.fn(),
      stopPeerPrompt: vi.fn(),
    };

    try {
      const service = new WorkspaceSyncService(profiles as never, codex as never);
      await expect(service.sync()).resolves.toMatchObject({
        selectedThreadId: "thread-1",
        historyCount: 1,
        fileCount: 1,
      });

      expect(listMessages).toHaveBeenCalledOnce();
      expect(publishRuntimeStatus).not.toHaveBeenCalled();
      expect(publishHistory).toHaveBeenCalledWith(
        "session-1",
        "member-token",
        {
          threadId: "thread-1",
          history: liveHistory,
        },
      );
      expect(publishSnapshot).not.toHaveBeenCalled();

      await service.sync();

      expect(listMessages).toHaveBeenCalledTimes(2);
      expect(publishRuntimeStatus).toHaveBeenCalledOnce();
      expect(publishRuntimeStatus).toHaveBeenCalledWith(
        "session-1",
        "member-token",
        "idle",
      );
      expect(publishSnapshot).toHaveBeenCalledOnce();
      expect(publishSnapshot).toHaveBeenCalledWith(
        "session-1",
        "member-token",
        expect.objectContaining({
          threadId: "thread-1",
          history: liveHistory,
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("establishes a catalog baseline without switching an existing task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-thread-baseline-"));
    const threads = [
      {
        id: "thread-2",
        name: "Existing newer task",
        preview: "Newer",
        updatedAt: 2,
        path: null,
      },
      {
        id: "thread-1",
        name: "Existing selected task",
        preview: "Selected",
        updatedAt: 1,
        path: null,
      },
    ];
    const workspace = {
      hostConnected: true,
      hostDeviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [],
      selectedThreadId: null,
      selectedThread: null,
      history: [],
      files: [],
      codexRuntimeStatus: "unavailable" as const,
      syncedAt: null,
    };
    vi.spyOn(RelayClient.prototype, "getWorkspaceSyncState").mockResolvedValue(
      syncState(workspace),
    );
    vi.spyOn(RelayClient.prototype, "publishWorkspaceCatalog").mockResolvedValue({
      ...workspace,
      threads: threads.map(({ path: _path, ...thread }) => thread),
    });
    const selectThread = vi.spyOn(RelayClient.prototype, "selectWorkspaceThread");
    const update = vi.fn().mockResolvedValue(profile);
    const profiles = {
      read: vi.fn().mockResolvedValue({
        ...profile,
        projectRoot: directory,
        observedThreadIds: undefined,
      }),
      update,
    };
    const codex = {
      listThreads: vi.fn().mockResolvedValue(threads),
    };

    try {
      const service = new WorkspaceSyncService(profiles as never, codex as never);
      await expect(service.sync()).resolves.toMatchObject({
        selectedThreadId: null,
        historyCount: 0,
      });
      expect(selectThread).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith({
        observedThreadIds: ["thread-2", "thread-1"],
        threadCatalogVersion: 1,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not rewrite the profile when the observed task list is unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-thread-stable-"));
    const thread = {
      id: "thread-1",
      name: "Existing task",
      preview: "Existing",
      updatedAt: 1,
      path: null,
    };
    const workspace = {
      hostConnected: true,
      hostDeviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [{
        id: thread.id,
        name: thread.name,
        preview: thread.preview,
        updatedAt: thread.updatedAt,
      }],
      selectedThreadId: null,
      selectedThread: null,
      history: [],
      files: [],
      codexRuntimeStatus: "unavailable" as const,
      syncedAt: null,
    };
    vi.spyOn(RelayClient.prototype, "getWorkspaceSyncState").mockResolvedValue(
      syncState(workspace),
    );
    const publishCatalog = vi.spyOn(RelayClient.prototype, "publishWorkspaceCatalog");
    const update = vi.fn().mockResolvedValue(profile);
    const profiles = {
      read: vi.fn().mockResolvedValue({
        ...profile,
        projectRoot: directory,
        observedThreadIds: [thread.id],
      }),
      update,
    };
    const codex = {
      listThreads: vi.fn().mockResolvedValue([thread]),
    };

    try {
      const service = new WorkspaceSyncService(profiles as never, codex as never);
      await expect(service.sync()).resolves.toMatchObject({
        selectedThreadId: null,
        historyCount: 0,
      });
      expect(publishCatalog).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates an existing profile once to the newest project task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-thread-migration-"));
    const newestThread = {
      id: "thread-newest",
      name: "Newest task",
      preview: "Current desktop work",
      updatedAt: 2,
      path: null,
    };
    const oldThread = {
      id: "thread-old",
      name: "Previously selected task",
      preview: "Old work",
      updatedAt: 1,
      path: null,
    };
    const catalog = [newestThread, oldThread].map(({ path: _path, ...thread }) => thread);
    const initialWorkspace = {
      hostConnected: true,
      hostDeviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: catalog,
      selectedThreadId: oldThread.id,
      selectedThread: catalog[1]!,
      history: [],
      files: [],
      codexRuntimeStatus: "idle" as const,
      syncedAt: null,
    };
    const selectedWorkspace = {
      ...initialWorkspace,
      selectedThreadId: newestThread.id,
      selectedThread: catalog[0]!,
    };
    const history = [
      {
        id: "command-newest",
        role: "command" as const,
        text: "tool: exec_command\nstatus: completed\ninput:\nnpm test",
        createdAt: null,
      },
    ];
    vi.spyOn(RelayClient.prototype, "getWorkspaceSyncState").mockResolvedValue(
      syncState(initialWorkspace),
    );
    const selectThread = vi
      .spyOn(RelayClient.prototype, "selectWorkspaceThread")
      .mockResolvedValue(selectedWorkspace);
    vi.spyOn(RelayClient.prototype, "listMessages").mockResolvedValue([]);
    vi.spyOn(RelayClient.prototype, "publishCodexRuntimeStatus").mockResolvedValue(
      syncState(selectedWorkspace),
    );
    vi.spyOn(RelayClient.prototype, "publishWorkspaceSnapshot").mockResolvedValue(syncState({
      ...selectedWorkspace,
      history,
      syncedAt: "2026-07-27T00:00:00.000Z",
    }));
    const update = vi.fn().mockResolvedValue(profile);
    const profiles = {
      read: vi.fn().mockResolvedValue({
        ...profile,
        projectRoot: directory,
        observedThreadIds: [newestThread.id, oldThread.id],
        threadCatalogVersion: undefined,
      }),
      update,
    };
    const codex = {
      listThreads: vi.fn().mockResolvedValue([newestThread, oldThread]),
      isThreadBusyForPrompt: vi.fn().mockResolvedValue(false),
      readThreadHistory: vi.fn().mockResolvedValue(history),
      getTurnStatus: vi.fn(),
      submitPeerPrompt: vi.fn(),
      stopPeerPrompt: vi.fn(),
    };

    try {
      const service = new WorkspaceSyncService(profiles as never, codex as never);
      await expect(service.sync()).resolves.toMatchObject({
        selectedThreadId: newestThread.id,
        historyCount: 1,
      });
      expect(selectThread).toHaveBeenCalledWith(
        "session-1",
        "member-token",
        newestThread.id,
      );
      expect(update).toHaveBeenCalledWith({
        observedThreadIds: [newestThread.id, oldThread.id],
        threadCatalogVersion: 1,
      });
      expect(update).toHaveBeenCalledWith({ threadId: newestThread.id });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("discovers and synchronizes a new Codex task in the approved project root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-new-thread-"));
    const newHistory = [
      {
        id: "user-new",
        role: "user" as const,
        text: "Start the new task",
        createdAt: "2026-07-26T00:00:02.000Z",
      },
    ];
    const oldThread = {
      id: "thread-1",
      name: "Existing task",
      preview: "Existing",
      updatedAt: 1,
      path: null,
    };
    const newThread = {
      id: "thread-2",
      name: "New task",
      preview: "Start the new task",
      updatedAt: 2,
      path: null,
    };
    const initialWorkspace = {
      hostConnected: true,
      hostDeviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [
        {
          id: oldThread.id,
          name: oldThread.name,
          preview: oldThread.preview,
          updatedAt: oldThread.updatedAt,
        },
      ],
      selectedThreadId: oldThread.id,
      selectedThread: {
        id: oldThread.id,
        name: oldThread.name,
        preview: oldThread.preview,
        updatedAt: oldThread.updatedAt,
      },
      history: [],
      files: [],
      codexRuntimeStatus: "idle" as const,
      syncedAt: "2026-07-26T00:00:01.000Z",
    };
    const catalogWorkspace = {
      ...initialWorkspace,
      threads: [
        {
          id: newThread.id,
          name: newThread.name,
          preview: newThread.preview,
          updatedAt: newThread.updatedAt,
        },
        ...initialWorkspace.threads,
      ],
    };
    const selectedWorkspace = {
      ...catalogWorkspace,
      selectedThreadId: newThread.id,
      selectedThread: catalogWorkspace.threads[0]!,
      syncedAt: null,
    };
    vi.spyOn(RelayClient.prototype, "getWorkspaceSyncState").mockResolvedValue(
      syncState(initialWorkspace),
    );
    const publishCatalog = vi
      .spyOn(RelayClient.prototype, "publishWorkspaceCatalog")
      .mockResolvedValue(catalogWorkspace);
    const selectThread = vi
      .spyOn(RelayClient.prototype, "selectWorkspaceThread")
      .mockResolvedValue(selectedWorkspace);
    vi.spyOn(RelayClient.prototype, "listMessages").mockResolvedValue([]);
    vi.spyOn(RelayClient.prototype, "publishCodexRuntimeStatus")
      .mockResolvedValue(syncState(selectedWorkspace));
    const publishSnapshot = vi
      .spyOn(RelayClient.prototype, "publishWorkspaceSnapshot")
      .mockResolvedValue(syncState({
        ...selectedWorkspace,
        history: newHistory,
        syncedAt: "2026-07-26T00:00:03.000Z",
      }));
    const update = vi.fn().mockResolvedValue(profile);
    const profiles = {
      read: vi.fn().mockResolvedValue({
        ...profile,
        projectRoot: directory,
        observedThreadIds: [oldThread.id],
      }),
      update,
    };
    const codex = {
      listThreads: vi.fn().mockResolvedValue([newThread, oldThread]),
      isThreadBusyForPrompt: vi.fn().mockResolvedValue(false),
      readThreadHistory: vi.fn().mockResolvedValue(newHistory),
      getTurnStatus: vi.fn(),
      submitPeerPrompt: vi.fn(),
      stopPeerPrompt: vi.fn(),
    };

    try {
      const service = new WorkspaceSyncService(profiles as never, codex as never);
      await expect(service.sync()).resolves.toMatchObject({
        selectedThreadId: newThread.id,
        historyCount: 1,
      });

      expect(codex.listThreads).toHaveBeenCalledWith(directory);
      expect(publishCatalog).toHaveBeenCalledWith(
        "session-1",
        "member-token",
        expect.objectContaining({
          threads: [
            expect.objectContaining({ id: newThread.id }),
            expect.objectContaining({ id: oldThread.id }),
          ],
        }),
      );
      expect(selectThread).toHaveBeenCalledWith(
        "session-1",
        "member-token",
        newThread.id,
      );
      expect(codex.readThreadHistory).toHaveBeenCalledWith(newThread.id, null);
      expect(publishSnapshot).toHaveBeenCalledWith(
        "session-1",
        "member-token",
        expect.objectContaining({ threadId: newThread.id, history: newHistory }),
      );
      expect(update).toHaveBeenCalledWith({
        observedThreadIds: [newThread.id, oldThread.id],
        threadCatalogVersion: 1,
      });
      expect(update).toHaveBeenCalledWith({ threadId: newThread.id });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
