import { CodexAppServerClient } from "../app-server-client.js";
import { LocalProfileStore, type LocalProfile } from "../local-profile.js";
import { WorkspaceSyncService } from "../workspace-sync-service.js";
import { HostProfileContext } from "./host-profile-context.js";
import { HostSessionService, isSessionToolName } from "./host-session-service.js";
import { hostToolArguments } from "./host-tool-arguments.js";
import { HostWorkspaceService } from "./host-workspace-service.js";
import { hostWorkAllowed, type HostWorkAdmission } from "./host-runtime-admission.js";

export class HostApplication {
  private readonly context: HostProfileContext;
  private readonly sessions: HostSessionService;
  private readonly workspace: HostWorkspaceService;

  constructor(
    private readonly profiles = new LocalProfileStore(),
    private readonly codex = new CodexAppServerClient(),
    private readonly workspaceSync = new WorkspaceSyncService(profiles, codex),
  ) {
    this.context = new HostProfileContext(profiles);
    this.sessions = new HostSessionService(this.context);
    this.workspace = new HostWorkspaceService(this.context, codex, workspaceSync);
  }

  async callTool(
    name: string,
    rawArguments: unknown,
    admission?: HostWorkAdmission,
  ): Promise<unknown> {
    const args = hostToolArguments(rawArguments);
    if (isSessionToolName(name)) return this.sessions.callTool(name, args);
    return this.workspace.callTool(name, args, admission);
  }

  async readRuntimeProfile(): Promise<LocalProfile | null> {
    return this.profiles.read();
  }

  async runBackgroundCycle(admission?: HostWorkAdmission): Promise<void> {
    await this.workspaceSync.processPendingFileOperations(
      admission ? { admission } : {},
    );
    if (!hostWorkAllowed(admission)) return;
    await this.workspaceSync.sync(false, admission ? { admission } : {});
  }

  async reconcileAfterResume(admission?: HostWorkAdmission): Promise<void> {
    await this.workspaceSync.sync(true, {
      allowNewWork: false,
      ...(admission ? { admission } : {}),
    });
  }

  async forwardPendingCommand(admission?: HostWorkAdmission): Promise<string | null> {
    return this.workspaceSync.forwardPendingCommand(admission ? { admission } : {});
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
