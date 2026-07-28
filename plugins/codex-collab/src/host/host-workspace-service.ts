import { hostname } from "node:os";
import { basename } from "node:path";
import { DEFAULT_CODEX_PROMPT_OPTIONS } from "@codex-collab/protocol";
import type { CodexAppServerClient } from "../app-server-client.js";
import type { LocalProfile } from "../local-profile.js";
import { RelayClient } from "../relay-client.js";
import type { WorkspaceSyncService } from "../workspace-sync-service.js";
import {
  openBoundProjectSandbox,
  openProjectSandbox,
  openWorkspaceSandboxes,
} from "../workspace-roots.js";
import { HostProfileContext, publicHostProfile } from "./host-profile-context.js";
import { stringArgument, type HostToolArguments } from "./host-tool-arguments.js";

export class HostWorkspaceService {
  constructor(
    private readonly context: HostProfileContext,
    private readonly codex: CodexAppServerClient,
    private readonly workspaceSync: WorkspaceSyncService,
  ) {}

  async callTool(name: string, args: HostToolArguments): Promise<unknown> {
    switch (name) {
      case "collab_pair_host":
        return this.pairHost(args);
      case "collab_refresh_workspace":
        return this.refreshWorkspace(args);
      case "collab_bind_thread":
        return this.bindThread(args);
      case "collab_list_codex_threads":
        return this.listCodexThreads(args);
      case "collab_forward_prompt":
        return this.forwardPrompt(args);
      case "collab_list_files":
        return this.listFiles();
      case "collab_read_file":
        return this.readFile(args);
      case "collab_write_file":
        return this.writeFile(args);
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

  private async refreshWorkspace(args: HostToolArguments): Promise<unknown> {
    const currentSession = await this.context.current();
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
    const workspace = await this.publishCatalog(profile, currentSession.relay);
    const imported = await this.workspaceSync.sync(true);
    return { publishedTaskCount: workspace.threads.length, ...imported };
  }

  private async bindThread(args: HostToolArguments): Promise<unknown> {
    const { profile } = await this.context.current();
    const projectSandbox = await openBoundProjectSandbox(
      profile.projectRoot,
      stringArgument(args, "projectRoot")!,
      profile.codexConfigRoot,
    );
    const updated = await this.context.profiles.update({
      threadId: stringArgument(args, "threadId")!,
      projectRoot: projectSandbox.getRoot(),
      observedThreadIds: undefined,
      threadCatalogVersion: 1,
    });
    return publicHostProfile(updated);
  }

  private async listCodexThreads(args: HostToolArguments): Promise<unknown> {
    const cwd = stringArgument(args, "cwd", true);
    return this.codex.listThreads(cwd ? (await openProjectSandbox(cwd)).getRoot() : undefined);
  }

  private async forwardPrompt(args: HostToolArguments): Promise<unknown> {
    const { profile, relay } = await this.context.current();
    if (profile.role !== "owner") throw new Error("Only the owner host can forward prompts");
    if (!profile.threadId) throw new Error("Bind a Codex thread first");
    const messageId = stringArgument(args, "messageId")!;
    if (profile.forwardedMessageIds?.includes(messageId)) {
      throw new Error("This collaboration message was already forwarded");
    }
    const messages = await relay.listMessages(profile.sessionId, profile.memberToken);
    const message = messages.find((candidate) => candidate.id === messageId);
    if (!message) throw new Error("Message was not found in the approved session");
    if (message.kind !== "codex_prompt") {
      throw new Error("Only codex_prompt messages can be forwarded");
    }
    const { projectSandbox } = await openWorkspaceSandboxes(
      profile.projectRoot,
      profile.codexConfigRoot,
    );
    const selectedThread = (await this.codex.listThreads(projectSandbox.getRoot())).find(
      (thread) => thread.id === profile.threadId,
    );
    if (!selectedThread) {
      throw new Error("Bound Codex task no longer belongs to the explicitly shared root");
    }
    const result = await this.codex.submitPeerPrompt({
      threadId: profile.threadId,
      projectRoot: projectSandbox.getRoot(),
      commandId: message.id,
      requesterMemberId: message.senderMemberId,
      ownerMemberId: profile.memberId,
      peerDisplayName: message.senderDisplayName,
      body: message.body,
      attachments: await Promise.all(
        message.attachments.map(async (attachment) => ({
          name: attachment.name,
          mediaType: attachment.mediaType,
          content: await relay.readMessageAttachment(
            profile.sessionId,
            profile.memberToken,
            message.id,
            attachment,
          ),
        })),
      ),
      codexOptions: message.codexOptions ?? DEFAULT_CODEX_PROMPT_OPTIONS,
    });
    if (result.status !== "submitted") {
      throw new Error(
        `Codex app-server did not submit the prompt (${result.reason ?? "not-ready"}). The prompt remains queued.`,
      );
    }
    await this.context.profiles.update({
      forwardedMessageIds: [...(profile.forwardedMessageIds ?? []), message.id],
    });
    await relay.updateMessageDeliveryStatus(
      profile.sessionId,
      profile.memberToken,
      message.id,
      "submitted",
      result.turnId ?? null,
    );
    return { forwarded: message, appServerSubmission: result };
  }

  private async listFiles(): Promise<unknown> {
    const { profile } = await this.context.current();
    const { projectSandbox } = await openWorkspaceSandboxes(
      profile.projectRoot,
      profile.codexConfigRoot,
    );
    return { root: projectSandbox.getRoot(), files: await projectSandbox.list() };
  }

  private async readFile(args: HostToolArguments): Promise<unknown> {
    const { profile } = await this.context.current();
    const { projectSandbox } = await openWorkspaceSandboxes(
      profile.projectRoot,
      profile.codexConfigRoot,
    );
    return projectSandbox.read(stringArgument(args, "path")!);
  }

  private async writeFile(args: HostToolArguments): Promise<unknown> {
    const { profile } = await this.context.current();
    const { projectSandbox } = await openWorkspaceSandboxes(
      profile.projectRoot,
      profile.codexConfigRoot,
    );
    return projectSandbox.write(
      stringArgument(args, "path")!,
      stringArgument(args, "content", true) ?? "",
      stringArgument(args, "expectedSha256", true) ?? "",
    );
  }

  private async publishCatalog(profile: LocalProfile, relay: RelayClient) {
    const { projectSandbox } = await openWorkspaceSandboxes(
      profile.projectRoot,
      profile.codexConfigRoot,
    );
    const threads = await this.codex.listThreads(projectSandbox.getRoot());
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
}
