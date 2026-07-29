import { hostname } from "node:os";
import { basename } from "node:path";
import type { CodexAppServerClient } from "../app-server/app-server-client.js";
import {
  deliverCodexCommand,
} from "../persistence/command-outbox.js";
import type { LocalProfile } from "../persistence/local-profile.js";
import { RelayClient } from "../relay/relay-client.js";
import type { WorkspaceSyncService } from "../sync/workspace-sync-service.js";
import {
  openBoundProjectSandbox,
  openProjectSandbox,
  openWorkspaceSandboxes,
} from "../workspace/workspace-roots.js";
import { HostProfileContext, publicHostProfile } from "./host-profile-context.js";
import { hostWorkAllowed, type HostWorkAdmission } from "./host-runtime-admission.js";
import { stringArgument, type HostToolArguments } from "./host-tool-arguments.js";

export class HostWorkspaceService {
  constructor(
    private readonly context: HostProfileContext,
    private readonly codex: CodexAppServerClient,
    private readonly workspaceSync: WorkspaceSyncService,
  ) {}

  async callTool(
    name: string,
    args: HostToolArguments,
    admission?: HostWorkAdmission,
  ): Promise<unknown> {
    switch (name) {
      case "collab_pair_host":
        return this.pairHost(args);
      case "collab_refresh_workspace":
        return this.refreshWorkspace(args, admission);
      case "collab_bind_thread":
        return this.bindThread(args, admission);
      case "collab_list_codex_threads":
        return this.listCodexThreads(args, admission);
      case "collab_forward_prompt":
        return this.forwardPrompt(args, admission);
      case "collab_list_files":
        return this.listFiles(admission);
      case "collab_read_file":
        return this.readFile(args, admission);
      case "collab_write_file":
        return this.writeFile(args, admission);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async pairHost(args: HostToolArguments): Promise<unknown> {
    const relayUrl =
      stringArgument(args, "relayUrl", true) ??
      process.env.CODEX_COLLAB_RELAY_URL ??
      "http://127.0.0.1:4177";
    const { projectSandbox, codexConfigSandbox } = await openWorkspaceSandboxes(
      stringArgument(args, "projectRoot")!,
      stringArgument(args, "codexConfigRoot", true),
    );
    const relay = new RelayClient(relayUrl);
    const claimed = await relay.claimHostPairing({
      pairingToken: stringArgument(args, "pairingToken")!,
      deviceLabel: hostname(),
      rootLabel: this.rootLabel(projectSandbox.getRoot()),
    });
    const profile: LocalProfile = {
      relayUrl,
      sessionId: claimed.session.id,
      memberId: claimed.owner.id,
      displayName: claimed.owner.displayName,
      role: "owner",
      memberToken: claimed.memberToken,
      projectRoot: projectSandbox.getRoot(),
      ...(codexConfigSandbox ? { codexConfigRoot: codexConfigSandbox.getRoot() } : {}),
      forwardedMessageIds: [],
    };
    await this.context.profiles.write(profile);
    const workspace = await this.publishCatalog(profile, relay);
    await this.context.profiles.update({
      observedThreadIds: workspace.threads.map((thread) => thread.id),
      threadCatalogVersion: 1,
    });
    return {
      session: claimed.session,
      profile: publicHostProfile(profile),
      publishedTaskCount: workspace.threads.length,
      next: "Choose a Codex task in the room's Codex 与文件 panel. It will import automatically while this host is running.",
    };
  }

  private async refreshWorkspace(
    args: HostToolArguments,
    admission?: HostWorkAdmission,
  ): Promise<unknown> {
    const currentSession = await this.context.current();
    this.assertAdmitted(admission);
    let { profile } = currentSession;
    if (profile.role !== "owner") {
      throw new Error("Only the owner host can publish a workspace");
    }
    const codexConfigRoot = stringArgument(args, "codexConfigRoot", true);
    if (codexConfigRoot) {
      const { codexConfigSandbox } = await openWorkspaceSandboxes(
        profile.projectRoot,
        codexConfigRoot,
      );
      profile = await this.context.profiles.update({
        codexConfigRoot: codexConfigSandbox!.getRoot(),
      });
    } else {
      await openWorkspaceSandboxes(profile.projectRoot, profile.codexConfigRoot);
    }
    this.assertAdmitted(admission);
    const workspace = await this.publishCatalog(profile, currentSession.relay, admission);
    const imported = await this.workspaceSync.sync(
      true,
      admission ? { admission } : {},
    );
    return { publishedTaskCount: workspace.threads.length, ...imported };
  }

  private async bindThread(
    args: HostToolArguments,
    admission?: HostWorkAdmission,
  ): Promise<unknown> {
    const { profile } = await this.context.current();
    const projectSandbox = await openBoundProjectSandbox(
      profile.projectRoot,
      stringArgument(args, "projectRoot")!,
      profile.codexConfigRoot,
    );
    this.assertAdmitted(admission);
    const updated = await this.context.profiles.update({
      threadId: stringArgument(args, "threadId")!,
      projectRoot: projectSandbox.getRoot(),
      observedThreadIds: undefined,
      threadCatalogVersion: 1,
    });
    return publicHostProfile(updated);
  }

  private async listCodexThreads(
    args: HostToolArguments,
    admission?: HostWorkAdmission,
  ): Promise<unknown> {
    const cwd = stringArgument(args, "cwd", true);
    this.assertAdmitted(admission);
    return this.codex.listThreads(cwd ? (await openProjectSandbox(cwd)).getRoot() : undefined);
  }

  private async forwardPrompt(
    args: HostToolArguments,
    admission?: HostWorkAdmission,
  ): Promise<unknown> {
    const { profile, relay } = await this.context.current();
    this.assertAdmitted(admission);
    if (profile.role !== "owner") throw new Error("Only the owner host can forward prompts");
    if (!profile.threadId) throw new Error("Bind a Codex thread first");
    const messageId = stringArgument(args, "messageId")!;
    const recovered = await this.workspaceSync.reconcileDurableReceipts(
      admission ? { admission } : {},
    );
    if (recovered && recovered.messageId !== messageId) {
      throw new Error(
        `Recovered pending command ${recovered.messageId}; retry command ${messageId} separately`,
      );
    }
    if (!recovered && profile.forwardedMessageIds?.includes(messageId)) {
      throw new Error("This collaboration message was already forwarded");
    }
    const messages = await relay.listMessages(profile.sessionId, profile.memberToken);
    this.assertAdmitted(admission);
    const message = messages.find((candidate) => candidate.id === messageId);
    if (!message) throw new Error("Message was not found in the approved session");
    if (message.kind !== "codex_prompt") {
      throw new Error("Only codex_prompt messages can be forwarded");
    }
    if (recovered) {
      return {
        forwarded: message,
        appServerSubmission: recovered.submission,
        recovered: true,
      };
    }
    const members = await relay.listMembers(profile.sessionId, profile.memberToken);
    this.assertAdmitted(admission);
    const senderApproved = message.senderMemberId === profile.memberId || members.some(
      (member) => member.id === message.senderMemberId && member.status === "approved",
    );
    if (!senderApproved) {
      await relay.updateMessageDeliveryStatus(
        profile.sessionId,
        profile.memberToken,
        message.id,
        "failed",
        null,
      );
      throw new Error("The collaboration member is no longer approved");
    }
    const { projectSandbox } = await openWorkspaceSandboxes(
      profile.projectRoot,
      profile.codexConfigRoot,
    );
    const selectedThread = (await this.codex.listThreads(projectSandbox.getRoot())).find(
      (thread) => thread.id === profile.threadId,
    );
    this.assertAdmitted(admission);
    if (!selectedThread) {
      throw new Error("Bound Codex task no longer belongs to the explicitly shared root");
    }
    this.assertAdmitted(admission);
    const delivered = await deliverCodexCommand(
      { ...profile, projectRoot: projectSandbox.getRoot() },
      profile.threadId,
      message,
      relay,
      this.codex,
      this.context.profiles,
      admission,
    );
    if (!delivered) {
      this.assertAdmitted(admission);
      throw new Error(
        "Codex app-server did not submit the prompt. The prompt remains queued.",
      );
    }
    return {
      forwarded: message,
      appServerSubmission: delivered.submission,
      recovered: delivered.recovered,
    };
  }

  private async listFiles(admission?: HostWorkAdmission): Promise<unknown> {
    const { profile } = await this.context.current();
    const { projectSandbox } = await openWorkspaceSandboxes(
      profile.projectRoot,
      profile.codexConfigRoot,
    );
    this.assertAdmitted(admission);
    return { root: projectSandbox.getRoot(), files: await projectSandbox.list() };
  }

  private async readFile(
    args: HostToolArguments,
    admission?: HostWorkAdmission,
  ): Promise<unknown> {
    const { profile } = await this.context.current();
    const { projectSandbox } = await openWorkspaceSandboxes(
      profile.projectRoot,
      profile.codexConfigRoot,
    );
    this.assertAdmitted(admission);
    return projectSandbox.read(stringArgument(args, "path")!);
  }

  private async writeFile(
    args: HostToolArguments,
    admission?: HostWorkAdmission,
  ): Promise<unknown> {
    const { profile } = await this.context.current();
    const { projectSandbox } = await openWorkspaceSandboxes(
      profile.projectRoot,
      profile.codexConfigRoot,
    );
    this.assertAdmitted(admission);
    return projectSandbox.write(
      stringArgument(args, "path")!,
      stringArgument(args, "content", true) ?? "",
      stringArgument(args, "expectedSha256", true) ?? "",
    );
  }

  private async publishCatalog(
    profile: LocalProfile,
    relay: RelayClient,
    admission?: HostWorkAdmission,
  ) {
    const { projectSandbox } = await openWorkspaceSandboxes(
      profile.projectRoot,
      profile.codexConfigRoot,
    );
    const threads = await this.codex.listThreads(projectSandbox.getRoot());
    this.assertAdmitted(admission);
    return relay.publishWorkspaceCatalog(profile.sessionId, profile.memberToken, {
      deviceLabel: hostname(),
      rootLabel: this.rootLabel(projectSandbox.getRoot()),
      threads: threads.map((thread) => ({
        id: thread.id,
        name: thread.name ?? null,
        preview: thread.preview?.trim().slice(0, 1_000) ?? "",
        updatedAt:
          typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt)
            ? thread.updatedAt
            : null,
      })),
    });
  }

  private rootLabel(root: string): string {
    return basename(root) || root;
  }

  private assertAdmitted(admission?: HostWorkAdmission): void {
    if (!hostWorkAllowed(admission)) {
      throw new Error("Host runtime stopped accepting workspace work");
    }
  }
}
