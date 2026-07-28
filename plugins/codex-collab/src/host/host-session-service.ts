import { hostname } from "node:os";
import type { MessageKind } from "@codex-collab/protocol";
import type { LocalProfile } from "../local-profile.js";
import { RelayClient } from "../relay-client.js";
import { openProjectSandbox, openWorkspaceSandboxes } from "../workspace-roots.js";
import { HostProfileContext, publicHostProfile } from "./host-profile-context.js";
import {
  integerArgument,
  stringArgument,
  type HostToolArguments,
} from "./host-tool-arguments.js";

const defaultRelayUrl = "http://127.0.0.1:4177";

const sessionToolNames = new Set([
  "collab_health",
  "collab_create_session",
  "collab_recover_session",
  "collab_create_invite",
  "collab_join_session",
  "collab_status",
  "collab_list_members",
  "collab_approve_member",
  "collab_send_message",
  "collab_list_messages",
]);

export function isSessionToolName(name: string): boolean {
  return sessionToolNames.has(name);
}

export class HostSessionService {
  constructor(private readonly context: HostProfileContext) {}

  async callTool(name: string, args: HostToolArguments): Promise<unknown> {
    switch (name) {
      case "collab_health":
        return this.health(args);
      case "collab_create_session":
        return this.createSession(args);
      case "collab_recover_session":
        return this.recoverSession(args);
      case "collab_create_invite":
        return this.createInvite(args);
      case "collab_join_session":
        return this.joinSession(args);
      case "collab_status":
        return this.status();
      case "collab_list_members":
        return this.listMembers();
      case "collab_approve_member":
        return this.approveMember(args);
      case "collab_send_message":
        return this.sendMessage(args);
      case "collab_list_messages":
        return this.listMessages(args);
      default:
        throw new Error(`Unknown session tool: ${name}`);
    }
  }

  private async health(args: HostToolArguments): Promise<unknown> {
    const existing = await this.context.profiles.read();
    const relayUrl =
      stringArgument(args, "relayUrl", true) ??
      existing?.relayUrl ??
      process.env.CODEX_COLLAB_RELAY_URL ??
      defaultRelayUrl;
    return new RelayClient(relayUrl).health();
  }

  private async createSession(args: HostToolArguments): Promise<unknown> {
    const relayUrl = this.relayUrl(args);
    const codexConfigRoot = stringArgument(args, "codexConfigRoot", true);
    const { projectSandbox, codexConfigSandbox } = await openWorkspaceSandboxes(
      stringArgument(args, "projectRoot")!,
      codexConfigRoot,
    );
    const created = await new RelayClient(relayUrl).createSession({
      name: stringArgument(args, "sessionName")!,
      ownerDisplayName: stringArgument(args, "displayName")!,
      deviceLabel: hostname(),
    });
    const threadId = stringArgument(args, "threadId", true);
    const profile: LocalProfile = {
      relayUrl,
      sessionId: created.session.id,
      memberId: created.owner.id,
      displayName: created.owner.displayName,
      role: "owner",
      memberToken: created.memberToken,
      projectRoot: projectSandbox.getRoot(),
      ...(codexConfigSandbox ? { codexConfigRoot: codexConfigSandbox.getRoot() } : {}),
      ...(threadId ? { threadId } : {}),
      forwardedMessageIds: [],
    };
    await this.context.profiles.write(profile);
    return {
      session: created.session,
      recoveryKey: created.recoveryKey,
      recoveryKeyNotice:
        "Save this owner recovery key now. The relay stores only its hash and cannot show it again.",
      profile: publicHostProfile(profile),
    };
  }

  private async recoverSession(args: HostToolArguments): Promise<unknown> {
    const relayUrl = this.relayUrl(args);
    const codexConfigRoot = stringArgument(args, "codexConfigRoot", true);
    const { projectSandbox, codexConfigSandbox } = await openWorkspaceSandboxes(
      stringArgument(args, "projectRoot")!,
      codexConfigRoot,
    );
    const recovered = await new RelayClient(relayUrl).recoverSession({
      sessionId: stringArgument(args, "sessionId")!,
      recoveryKey: stringArgument(args, "recoveryKey")!,
      deviceLabel: hostname(),
    });
    const threadId = stringArgument(args, "threadId", true);
    const profile: LocalProfile = {
      relayUrl,
      sessionId: recovered.session.id,
      memberId: recovered.owner.id,
      displayName: recovered.owner.displayName,
      role: "owner",
      memberToken: recovered.memberToken,
      projectRoot: projectSandbox.getRoot(),
      ...(codexConfigSandbox ? { codexConfigRoot: codexConfigSandbox.getRoot() } : {}),
      ...(threadId ? { threadId } : {}),
      forwardedMessageIds: [],
    };
    await this.context.profiles.write(profile);
    return { session: recovered.session, profile: publicHostProfile(profile) };
  }

  private async createInvite(args: HostToolArguments): Promise<unknown> {
    const { profile, relay } = await this.context.current();
    return relay.createInvite(profile.sessionId, profile.memberToken, {
      expiresInMinutes: integerArgument(args, "expiresInMinutes", 60),
      maxUses: integerArgument(args, "maxUses", 1),
    });
  }

  private async joinSession(args: HostToolArguments): Promise<unknown> {
    const relayUrl = this.relayUrl(args);
    const projectSandbox = await openProjectSandbox(stringArgument(args, "projectRoot")!);
    const relay = new RelayClient(relayUrl);
    const joined = await relay.joinInvite({
      inviteToken: stringArgument(args, "inviteToken")!,
      displayName: stringArgument(args, "displayName")!,
      deviceLabel: hostname(),
    });
    const profile: LocalProfile = {
      relayUrl,
      sessionId: joined.session.id,
      memberId: joined.member.id,
      displayName: joined.member.displayName,
      role: joined.member.role,
      memberToken: joined.memberToken,
      projectRoot: projectSandbox.getRoot(),
      forwardedMessageIds: [],
    };
    await this.context.profiles.write(profile);
    return { session: joined.session, member: joined.member, approvalRequired: true };
  }

  private async status(): Promise<unknown> {
    const { profile, relay } = await this.context.current();
    const [health, member] = await Promise.all([
      relay.health(),
      relay.currentMember(profile.sessionId, profile.memberToken),
    ]);
    return { relay: health, member, profile: publicHostProfile(profile) };
  }

  private async listMembers(): Promise<unknown> {
    const { profile, relay } = await this.context.current();
    return relay.listMembers(profile.sessionId, profile.memberToken);
  }

  private async approveMember(args: HostToolArguments): Promise<unknown> {
    const { profile, relay } = await this.context.current();
    if (profile.role !== "owner") throw new Error("Only the owner can approve members");
    return relay.approveMember(
      profile.sessionId,
      profile.memberToken,
      stringArgument(args, "memberId")!,
    );
  }

  private async sendMessage(args: HostToolArguments): Promise<unknown> {
    const { profile, relay } = await this.context.current();
    const kind = (stringArgument(args, "kind", true) ?? "chat") as MessageKind;
    if (kind !== "chat" && kind !== "codex_prompt") {
      throw new Error("kind must be chat or codex_prompt");
    }
    return relay.sendMessage(
      profile.sessionId,
      profile.memberToken,
      kind,
      stringArgument(args, "body")!,
    );
  }

  private async listMessages(args: HostToolArguments): Promise<unknown> {
    const { profile, relay } = await this.context.current();
    const messages = await relay.listMessages(
      profile.sessionId,
      profile.memberToken,
      stringArgument(args, "after", true),
    );
    const lastMessage = messages.at(-1);
    if (lastMessage) {
      await this.context.profiles.update({ lastMessageAt: lastMessage.createdAt });
    }
    return messages;
  }

  private relayUrl(args: HostToolArguments): string {
    return (
      stringArgument(args, "relayUrl", true) ??
      process.env.CODEX_COLLAB_RELAY_URL ??
      defaultRelayUrl
    );
  }
}
