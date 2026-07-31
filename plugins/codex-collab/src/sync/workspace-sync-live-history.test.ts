import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayClient } from "../relay/relay-client.js";
import { WorkspaceSyncService } from "./workspace-sync-service.js";
import { profile, syncState } from "./workspace-sync-test-fixtures.js";

describe("workspace live history sync", () => {
  beforeEach(() => {
    vi.spyOn(RelayClient.prototype, "listMembers").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes an unavailable runtime state when the Host cannot catch up", async () => {
    const publishRuntimeStatus = vi
      .spyOn(RelayClient.prototype, "publishCodexRuntimeStatus")
      .mockResolvedValue({} as never);
    const service = new WorkspaceSyncService(
      { read: vi.fn().mockResolvedValue(profile) } as never,
      {} as never,
    );

    await service.publishRuntimeUnavailable();

    expect(publishRuntimeStatus).toHaveBeenCalledWith(
      profile.sessionId,
      profile.memberToken,
      "unavailable",
    );
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

  it("publishes a replacement snapshot after a file is deleted locally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-delete-sync-"));
    await writeFile(join(directory, "README.md"), "# Local\n", "utf8");
    const thread = { id: "thread-1", name: "Task", preview: "", updatedAt: 1, path: null };
    const workspace = {
      hostConnected: true,
      hostDeviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [{ id: thread.id, name: thread.name, preview: thread.preview, updatedAt: 1 }],
      selectedThreadId: thread.id,
      selectedThread: { id: thread.id, name: thread.name, preview: thread.preview, updatedAt: 1 },
      history: [],
      files: [{
        path: "README.md",
        size: 8,
        modifiedAt: "2026-07-28T00:00:00.000Z",
        sha256: "a".repeat(64),
      }],
      codexRuntimeStatus: "idle" as const,
      syncedAt: "2026-07-28T00:00:00.000Z",
    };
    vi.spyOn(RelayClient.prototype, "getWorkspaceSyncState").mockResolvedValue(syncState(workspace));
    vi.spyOn(RelayClient.prototype, "listMessages").mockResolvedValue([]);
    const publishHistory = vi
      .spyOn(RelayClient.prototype, "publishWorkspaceHistory")
      .mockResolvedValue(syncState(workspace));
    const publishSnapshot = vi
      .spyOn(RelayClient.prototype, "publishWorkspaceSnapshot")
      .mockResolvedValue(syncState(workspace));
    const profiles = {
      read: vi.fn().mockResolvedValue({
        ...profile,
        projectRoot: directory,
        observedThreadIds: [thread.id],
        threadCatalogVersion: 1,
      }),
      update: vi.fn().mockResolvedValue(profile),
    };
    const codex = {
      listThreads: vi.fn().mockResolvedValue([thread]),
      isThreadBusyForPrompt: vi.fn().mockResolvedValue(false),
      readThreadHistory: vi.fn().mockResolvedValue([]),
      getTurnStatus: vi.fn(),
      submitPeerPrompt: vi.fn(),
      stopPeerPrompt: vi.fn(),
    };

    try {
      const service = new WorkspaceSyncService(profiles as never, codex as never);
      await service.sync();
      await rm(join(directory, "README.md"));
      await service.sync();

      expect(publishHistory).toHaveBeenCalledOnce();
      expect(publishSnapshot).toHaveBeenCalledOnce();
      expect(publishSnapshot.mock.calls[0]?.[2]).toMatchObject({ files: [] });
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
      files: [
        {
          path: "README.md",
          size: 7,
          modifiedAt: "2026-07-27T00:00:00.000Z",
          sha256: "a".repeat(64),
        },
      ],
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
    const publishHistory = vi
      .spyOn(RelayClient.prototype, "publishWorkspaceHistory")
      .mockResolvedValue(syncState({
        ...selectedWorkspace,
        history,
        syncedAt: "2026-07-27T00:00:00.000Z",
      }));
    const publishSnapshot = vi.spyOn(
      RelayClient.prototype,
      "publishWorkspaceSnapshot",
    );
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
      expect(publishHistory).toHaveBeenCalledWith(
        "session-1",
        "member-token",
        expect.objectContaining({ threadId: newestThread.id, history }),
      );
      expect(publishSnapshot).not.toHaveBeenCalled();
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
