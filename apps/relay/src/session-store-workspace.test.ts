import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createStore } from "./session-store-test-support.js";

describe("SessionStore workspace history", () => {
  it("attributes every new Codex command to the selected workspace task", () => {
    const store = createStore();
    const created = store.createSession("Task room", "Owner");
    expect(() =>
      store.addMessage(created.session.id, created.memberToken, "codex_prompt", "No task"),
    ).toThrowError(/select/i);
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [
        { id: "thread-one", name: "One", preview: "", updatedAt: null },
        { id: "thread-two", name: "Two", preview: "", updatedAt: null },
      ],
    });
    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-one");
    const first = store.addMessage(
      created.session.id,
      created.memberToken,
      "codex_prompt",
      "First task",
    );
    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-two");
    const second = store.addMessage(
      created.session.id,
      created.memberToken,
      "codex_stop",
      "Stop second task",
    );
    expect(first.workspaceThreadId).toBe("thread-one");
    expect(second.workspaceThreadId).toBe("thread-two");
  });

  it("imports an owner-selected Codex task and exposes it only to approved members", () => {
    const store = createStore();
    const created = store.createSession("Import room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Codex-Collab");
    const invite = store.createInvite(created.session.id, created.memberToken, 60, 1);
    const guest = store.joinInvite(invite.inviteToken, "Reviewer");

    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Codex-Collab",
      threads: [
        {
          id: "thread-1",
          name: "Release task",
          preview: "Finish the collaboration loop",
          updatedAt: 123,
        },
      ],
    });
    expect(() =>
      store.getWorkspace(created.session.id, guest.memberToken),
    ).toThrowError(/approval/i);

    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-1");
    expect(
      store.publishCodexRuntimeStatus(
        created.session.id,
        host.memberToken,
        "running",
      ).workspace.codexRuntimeStatus,
    ).toBe("running");
    const minimalSnapshot = store.publishWorkspaceSnapshot(
      created.session.id,
      host.memberToken,
      {
        threadId: "thread-1",
        history: [
          {
            id: "entry-1",
            role: "user",
            text: "Run the full test suite",
            createdAt: "2026-07-25T00:00:00.000Z",
          },
        ],
        files: [
          {
            path: "README.md",
            content: "# Codex Collab",
            size: 14,
            modifiedAt: "2026-07-25T00:00:00.000Z",
            sha256: createHash("sha256").update("# Codex Collab").digest("hex"),
          },
        ],
      },
      true,
    );
    expect(minimalSnapshot).toMatchObject({ historyCount: 1, fileCount: 1 });
    expect(minimalSnapshot).not.toHaveProperty("history");
    expect(minimalSnapshot).not.toHaveProperty("files");

    const rowBefore = store.db
      .prepare(
        "SELECT rowid FROM workspace_files WHERE session_id = ? AND path = 'README.md'",
      )
      .get(created.session.id) as { rowid: number };
    store.publishWorkspaceSnapshot(created.session.id, host.memberToken, {
      threadId: "thread-1",
      history: [
        {
          id: "entry-1",
          role: "user",
          text: "Run the full test suite",
          createdAt: "2026-07-25T00:00:00.000Z",
        },
      ],
      files: [
        {
          path: "README.md",
          content: "# Codex Collab",
          size: 14,
          modifiedAt: "2026-07-25T00:00:00.000Z",
          sha256: createHash("sha256").update("# Codex Collab").digest("hex"),
        },
      ],
    });
    const rowAfter = store.db
      .prepare(
        "SELECT rowid FROM workspace_files WHERE session_id = ? AND path = 'README.md'",
      )
      .get(created.session.id) as { rowid: number };
    expect(rowAfter.rowid).toBe(rowBefore.rowid);

    store.approveMember(created.session.id, created.memberToken, guest.member.id);
    const workspace = store.getWorkspace(created.session.id, guest.memberToken);
    expect(workspace.selectedThread?.name).toBe("Release task");
    expect(workspace.history[0]?.text).toBe("Run the full test suite");
    expect(workspace.files[0]?.path).toBe("README.md");
    expect(workspace.threads).toEqual([]);
    const ownerOverview = store.getWorkspaceOverview(
      created.session.id,
      created.memberToken,
    );
    expect(ownerOverview.historyCount).toBe(1);
    expect(ownerOverview.files[0]).not.toHaveProperty("content");
    expect(ownerOverview.threads).toHaveLength(1);
    expect(ownerOverview).not.toHaveProperty("history");
    const guestOverview = store.getWorkspaceOverview(
      created.session.id,
      guest.memberToken,
    );
    expect(guestOverview.threads).toEqual([]);
    expect(store.getWorkspaceHistory(created.session.id, guest.memberToken)).toMatchObject({
      selectedThreadId: "thread-1",
      history: [{ text: "Run the full test suite" }],
    });
    const hostSyncState = store.getWorkspaceSyncState(
      created.session.id,
      host.memberToken,
    );
    expect(hostSyncState).toMatchObject({ historyCount: 1, fileCount: 1 });
    expect(hostSyncState).not.toHaveProperty("history");
    expect(hostSyncState).not.toHaveProperty("files");
    expect(() =>
      store.getWorkspaceSyncState(created.session.id, created.memberToken),
    ).toThrowError(/host|token/i);
    expect(
      store.getWorkspaceFile(created.session.id, guest.memberToken, "README.md").content,
    ).toBe("# Codex Collab");
    expect(() =>
      store.selectWorkspaceThread(created.session.id, guest.memberToken, "thread-1"),
    ).toThrowError(/owner/i);
  });

  it("updates live task history without replacing the shared file snapshot", () => {
    const store = createStore();
    const created = store.createSession("Live room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [{ id: "thread-1", name: "Live task", preview: "", updatedAt: 1 }],
    });
    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-1");
    store.publishWorkspaceSnapshot(created.session.id, host.memberToken, {
      threadId: "thread-1",
      history: [],
      files: [
        {
          path: "README.md",
          content: "keep me",
          size: 7,
          modifiedAt: "2026-07-25T00:00:00.000Z",
          sha256: createHash("sha256").update("keep me").digest("hex"),
        },
      ],
    });

    const workspace = store.publishWorkspaceHistory(
      created.session.id,
      host.memberToken,
      {
        threadId: "thread-1",
        history: [
          {
            id: "call-1",
            role: "command",
            text: "tool: exec_command\nstatus: running\ninput:\nnpm test",
            createdAt: "2026-07-25T00:00:01.000Z",
          },
        ],
      },
    );

    expect(workspace.history[0]?.text).toContain("status: running");
    expect(workspace.files).toHaveLength(1);
    expect(
      store.getWorkspaceFile(
        created.session.id,
        created.memberToken,
        "README.md",
      ).content,
    ).toBe("keep me");
    expect(() =>
      store.publishWorkspaceHistory(created.session.id, host.memberToken, {
        threadId: "another-thread",
        history: [],
      }),
    ).toThrowError(/select/i);
  });

  it("pages workspace history from newest to oldest with stable opaque cursors", () => {
    const store = createStore();
    const created = store.createSession("Paged room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [{ id: "thread-1", name: "Paged task", preview: "", updatedAt: 1 }],
    });
    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-1");
    const history = Array.from({ length: 95 }, (_, index) => ({
      id: index === 10 || index === 11 ? "duplicate" : `entry-${index}`,
      role: (index >= 50 && index <= 60 ? "reasoning" : "assistant") as
        | "reasoning"
        | "assistant",
      text: `Record ${index}`,
      createdAt: index % 7 === 0 ? null : `2026-07-27T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    store.publishWorkspaceHistory(created.session.id, host.memberToken, {
      threadId: "thread-1",
      history,
    });

    const newest = store.getWorkspaceHistoryPage(
      created.session.id,
      created.memberToken,
      { limit: 40 },
    );
    expect(newest.items).toHaveLength(40);
    expect(newest.items[0]?.entry.text).toBe("Record 55");
    expect(newest.items.at(-1)?.entry.text).toBe("Record 94");
    expect(newest).toMatchObject({ totalCount: 95, hasOlder: true });
    expect(newest.olderCursor).toEqual(expect.any(String));

    const middle = store.getWorkspaceHistoryPage(
      created.session.id,
      created.memberToken,
      { limit: 40, before: newest.olderCursor },
    );
    expect(middle.items.map((item) => item.entry.text)).toEqual(
      history.slice(15, 55).map((entry) => entry.text),
    );
    expect(middle.items.at(-1)?.entry.role).toBe("reasoning");
    expect(newest.items[0]?.entry.role).toBe("reasoning");
    expect(middle.items.at(-1)?.groupKey).toEqual(expect.any(String));
    expect(middle.items.at(-1)?.groupKey).toBe(newest.items[0]?.groupKey);
    const oldest = store.getWorkspaceHistoryPage(
      created.session.id,
      created.memberToken,
      { limit: 40, before: middle.olderCursor },
    );
    expect(oldest.items.map((item) => item.entry.text)).toEqual(
      history.slice(0, 15).map((entry) => entry.text),
    );
    expect(oldest).toMatchObject({ hasOlder: false, olderCursor: null });
    expect(new Set(oldest.items.map((item) => item.key)).size).toBe(15);
    expect(store.getWorkspaceHistory(created.session.id, created.memberToken).history).toHaveLength(95);

    store.publishWorkspaceHistory(created.session.id, host.memberToken, {
      threadId: "thread-1",
      history: [
        ...history,
        {
          id: "entry-95",
          role: "assistant",
          text: "Record 95",
          createdAt: null,
        },
      ],
    });
    expect(
      store.getWorkspaceHistoryPage(created.session.id, created.memberToken, {
        limit: 40,
        before: newest.olderCursor,
      }).items[0]?.entry.text,
    ).toBe("Record 15");

    store.publishWorkspaceHistory(created.session.id, host.memberToken, {
      threadId: "thread-1",
      history: history.map((entry, index) =>
        index === 55 ? { ...entry, text: "Changed anchor" } : entry,
      ),
    });
    expect(() =>
      store.getWorkspaceHistoryPage(created.session.id, created.memberToken, {
        limit: 40,
        before: newest.olderCursor,
      }),
    ).toThrowError(/changed/i);
    expect(() =>
      store.getWorkspaceHistoryPage(created.session.id, created.memberToken, {
        before: "not-a-cursor",
      }),
    ).toThrowError(/cursor/i);
  });

  it("clears stale task history but preserves root-scoped files when selecting another task", () => {
    const store = createStore();
    const created = store.createSession("Switch room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [
        { id: "one", name: "One", preview: "", updatedAt: null },
        { id: "two", name: "Two", preview: "", updatedAt: null },
      ],
    });
    store.selectWorkspaceThread(created.session.id, created.memberToken, "one");
    store.publishWorkspaceSnapshot(created.session.id, host.memberToken, {
      threadId: "one",
      history: [
        { id: "old", role: "assistant", text: "Old task", createdAt: null },
      ],
      files: [
        {
          path: "src/shared.ts",
          content: "export const shared = true;",
          size: 27,
          modifiedAt: "2026-07-28T00:00:00.000Z",
          sha256: createHash("sha256")
            .update("export const shared = true;")
            .digest("hex"),
        },
      ],
      directories: ["src", "src/empty"],
    });

    const switched = store.selectWorkspaceThread(
      created.session.id,
      created.memberToken,
      "two",
    );
    expect(switched.history).toEqual([]);
    expect(switched.files).toEqual([
      expect.objectContaining({ path: "src/shared.ts" }),
    ]);
    expect(switched.directories).toEqual(["src", "src/empty"]);
    expect(switched.syncedAt).toBeNull();
  });

});
