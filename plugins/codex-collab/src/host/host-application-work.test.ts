import { describe, expect, it, vi } from "vitest";
import { DurableRecoveryBlockedError } from "../durable-recovery.js";
import type { WorkspaceSyncService } from "../workspace-sync-service.js";
import { HostApplicationWork } from "./host-application-work.js";

function fixture() {
  const workspaceSync = {
    reconcileDurableReceipts: vi.fn().mockResolvedValue(null),
    processPendingFileOperations: vi.fn().mockResolvedValue(0),
    sync: vi.fn().mockResolvedValue({}),
    forwardPendingCommand: vi.fn().mockResolvedValue(null),
  } as unknown as WorkspaceSyncService;
  return { work: new HostApplicationWork(workspaceSync), workspaceSync };
}

describe("HostApplicationWork durable gate", () => {
  it("reconciles durable receipts before catch-up sync", async () => {
    const { work, workspaceSync } = fixture();
    const order: string[] = [];
    vi.mocked(workspaceSync.reconcileDurableReceipts).mockImplementation(async () => {
      order.push("durable");
      return null;
    });
    vi.mocked(workspaceSync.sync).mockImplementation(async () => {
      order.push("sync");
      return {} as never;
    });

    await work.reconcileAfterResume();

    expect(order).toEqual(["durable", "sync"]);
    expect(workspaceSync.sync).toHaveBeenCalledWith(true, {
      allowNewWork: false,
    });
  });

  it.each([
    ["session", "collab_create_session"],
    ["session", "collab_recover_session"],
    ["session", "collab_join_session"],
    ["workspace", "collab_pair_host"],
  ] as const)("blocks profile-replacing %s tool %s before overwrite", async (kind, name) => {
    const { work, workspaceSync } = fixture();
    const blocked = new DurableRecoveryBlockedError("pending receipt");
    vi.mocked(workspaceSync.reconcileDurableReceipts).mockRejectedValue(blocked);
    const replaceProfile = vi.fn().mockResolvedValue(undefined);

    const pending = kind === "session"
      ? work.runSessionTool(name, replaceProfile)
      : work.runWorkspaceTool(
          name,
          { isAllowed: () => false },
          replaceProfile,
        );

    await expect(pending).rejects.toBe(blocked);
    expect(replaceProfile).not.toHaveBeenCalled();
    expect(workspaceSync.reconcileDurableReceipts).toHaveBeenCalledWith();
  });

  it("waits for current file work before another gate inspects receipts", async () => {
    const { work, workspaceSync } = fixture();
    let releaseFileWork!: () => void;
    vi.mocked(workspaceSync.processPendingFileOperations).mockReturnValue(
      new Promise<number>((resolve) => {
        releaseFileWork = () => resolve(1);
      }),
    );
    const background = work.runBackgroundCycle();
    await vi.waitFor(() =>
      expect(workspaceSync.processPendingFileOperations).toHaveBeenCalledOnce(),
    );
    const nextOperation = vi.fn().mockResolvedValue("ok");
    const next = work.runWorkspaceTool(
      "collab_write_file",
      { isAllowed: () => true },
      nextOperation,
    );

    expect(workspaceSync.reconcileDurableReceipts).toHaveBeenCalledTimes(1);
    expect(nextOperation).not.toHaveBeenCalled();
    releaseFileWork();
    await background;
    await expect(next).resolves.toBe("ok");
    expect(workspaceSync.reconcileDurableReceipts).toHaveBeenCalledTimes(2);
  });

  it("does not process a file when command receipt recovery is blocked", async () => {
    const { work, workspaceSync } = fixture();
    vi.mocked(workspaceSync.reconcileDurableReceipts).mockRejectedValue(
      new DurableRecoveryBlockedError("ambiguous command submission"),
    );

    await expect(work.runBackgroundCycle()).rejects.toBeInstanceOf(
      DurableRecoveryBlockedError,
    );
    expect(workspaceSync.processPendingFileOperations).not.toHaveBeenCalled();
    expect(workspaceSync.sync).not.toHaveBeenCalled();
  });
});
