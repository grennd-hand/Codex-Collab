import { CodexAppServerClient } from "../app-server-client.js";
import { LocalProfileStore, type LocalProfile } from "../local-profile.js";
import { WorkspaceSyncService } from "../workspace-sync-service.js";
import { HostProfileContext } from "./host-profile-context.js";
import { HostSessionService, isSessionToolName } from "./host-session-service.js";
import { hostToolArguments } from "./host-tool-arguments.js";
import { HostWorkspaceService } from "./host-workspace-service.js";
import type { HostWorkAdmission } from "./host-runtime-admission.js";
import type { DurableRecoveryBlockedError } from "../durable-recovery.js";
import { HostApplicationWork } from "./host-application-work.js";

export class HostApplication {
  private readonly context: HostProfileContext;
  private readonly sessions: HostSessionService;
  private readonly workspace: HostWorkspaceService;
  private readonly work: HostApplicationWork;

  constructor(
    private readonly profiles = new LocalProfileStore(),
    private readonly codex = new CodexAppServerClient(),
    private readonly workspaceSync = new WorkspaceSyncService(profiles, codex),
  ) {
    this.context = new HostProfileContext(profiles);
    this.sessions = new HostSessionService(this.context);
    this.workspace = new HostWorkspaceService(this.context, codex, workspaceSync);
    this.work = new HostApplicationWork(workspaceSync);
  }

  async callTool(
    name: string,
    rawArguments: unknown,
    admission?: HostWorkAdmission,
  ): Promise<unknown> {
    const args = hostToolArguments(rawArguments);
    if (isSessionToolName(name)) {
      return this.work.runSessionTool(name, () => this.sessions.callTool(name, args));
    }
    return this.work.runWorkspaceTool(
      name,
      admission,
      () => this.workspace.callTool(name, args, admission),
    );
  }

  setDurableFailureHandler(
    handler: (error: DurableRecoveryBlockedError) => void,
  ): void {
    this.work.setFailureHandler(handler);
  }

  async waitForActiveWork(): Promise<void> {
    await this.work.waitForActiveWork();
  }

  async readRuntimeProfile(): Promise<LocalProfile | null> {
    return this.profiles.read();
  }

  async runBackgroundCycle(admission?: HostWorkAdmission): Promise<void> {
    await this.work.runBackgroundCycle(admission);
  }

  async reconcileAfterResume(admission?: HostWorkAdmission): Promise<void> {
    await this.work.reconcileAfterResume(admission);
  }

  async forwardPendingCommand(admission?: HostWorkAdmission): Promise<string | null> {
    return this.work.forwardPendingCommand(admission);
  }

  async cancelActiveWork(): Promise<void> {
    const profile = await this.profiles.read();
    if (!profile || profile.role !== "owner" || !profile.threadId) return;
    await this.codex.stopPeerPrompt({ threadId: profile.threadId });
  }

  async close(): Promise<void> {
    await this.codex.close();
  }

}
