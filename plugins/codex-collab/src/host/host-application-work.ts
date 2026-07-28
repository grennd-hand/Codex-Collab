import type { DurableRecoveryBlockedError } from "../durable-recovery.js";
import type { WorkspaceSyncService } from "../workspace-sync-service.js";
import { HostDurableWorkGate } from "./host-durable-work-gate.js";
import { hostWorkAllowed, type HostWorkAdmission } from "./host-runtime-admission.js";

const durableGuardedTools = new Set([
  "collab_pair_host",
  "collab_refresh_workspace",
  "collab_bind_thread",
  "collab_list_codex_threads",
  "collab_list_files",
  "collab_read_file",
  "collab_write_file",
]);
const profileReplacingWorkspaceTools = new Set(["collab_pair_host"]);
const profileReplacingSessionTools = new Set([
  "collab_create_session",
  "collab_recover_session",
  "collab_join_session",
]);

export class HostApplicationWork {
  private readonly gate = new HostDurableWorkGate();

  constructor(private readonly workspaceSync: WorkspaceSyncService) {}

  runSessionTool<T>(name: string, operation: () => Promise<T>): Promise<T> {
    if (!profileReplacingSessionTools.has(name)) return operation();
    return this.gate.run(async () => {
      await this.workspaceSync.reconcileDurableReceipts();
      return operation();
    });
  }

  runWorkspaceTool<T>(
    name: string,
    admission: HostWorkAdmission | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.gate.run(async () => {
      if (durableGuardedTools.has(name)) {
        if (profileReplacingWorkspaceTools.has(name)) {
          await this.workspaceSync.reconcileDurableReceipts();
        } else {
          await this.workspaceSync.reconcileDurableReceipts(
            admission ? { admission } : {},
          );
        }
      }
      return operation();
    });
  }

  runBackgroundCycle(admission?: HostWorkAdmission): Promise<void> {
    return this.gate.run(async () => {
      const options = admission ? { admission } : {};
      await this.workspaceSync.reconcileDurableReceipts(options);
      await this.workspaceSync.processPendingFileOperations(options);
      if (hostWorkAllowed(admission)) await this.workspaceSync.sync(false, options);
    });
  }

  reconcileAfterResume(admission?: HostWorkAdmission): Promise<void> {
    return this.gate.run(async () => {
      const options = admission ? { admission } : {};
      await this.workspaceSync.reconcileDurableReceipts(options);
      await this.workspaceSync.sync(true, { allowNewWork: false, ...options });
    });
  }

  forwardPendingCommand(admission?: HostWorkAdmission): Promise<string | null> {
    return this.gate.run(async () => {
      const options = admission ? { admission } : {};
      await this.workspaceSync.reconcileDurableReceipts(options);
      return this.workspaceSync.forwardPendingCommand(options);
    });
  }

  setFailureHandler(handler: (error: DurableRecoveryBlockedError) => void): void {
    this.gate.setFailureHandler(handler);
  }

  waitForActiveWork(): Promise<void> {
    return this.gate.waitForActiveWork();
  }
}
