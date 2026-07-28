import type { Message } from "@codex-collab/protocol";
import type { CodexAppServerClient } from "./app-server-client.js";
import {
  forwardNextCodexPrompt,
  rejectUnapprovedQueuedCommands,
} from "./codex-command-sync.js";
import type { LocalProfile, LocalProfileStore } from "./local-profile.js";
import type { RelayClient } from "./relay-client.js";
import {
  workspaceWorkAllowed,
  type WorkspaceSyncAdmission,
} from "./workspace-sync-admission.js";

export class WorkspaceCommandForwarder {
  private forwarding: Promise<string | null> | null = null;

  constructor(
    private readonly profiles: LocalProfileStore,
    private readonly codex: CodexAppServerClient,
  ) {}

  forward(
    profile: LocalProfile,
    threadId: string,
    relay: RelayClient,
    threadBusy: boolean,
    prefetchedMessages?: Message[],
    admission?: WorkspaceSyncAdmission,
  ): Promise<string | null> {
    if (this.forwarding) return this.forwarding;
    const pending = this.forwardApproved(
      profile,
      threadId,
      relay,
      threadBusy,
      prefetchedMessages,
      admission,
    );
    this.forwarding = pending;
    const clear = () => {
      if (this.forwarding === pending) this.forwarding = null;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async forwardApproved(
    profile: LocalProfile,
    threadId: string,
    relay: RelayClient,
    threadBusy: boolean,
    prefetchedMessages?: Message[],
    admission?: WorkspaceSyncAdmission,
  ): Promise<string | null> {
    const messages = prefetchedMessages ??
      (await relay.listMessages(profile.sessionId, profile.memberToken));
    if (!workspaceWorkAllowed(admission)) return null;
    const members = await relay.listMembers(profile.sessionId, profile.memberToken);
    if (!workspaceWorkAllowed(admission)) return null;
    await rejectUnapprovedQueuedCommands(profile, threadId, messages, members, relay);
    if (!workspaceWorkAllowed(admission)) return null;
    return forwardNextCodexPrompt(
      profile,
      threadId,
      relay,
      this.codex,
      this.profiles,
      threadBusy,
      messages,
      admission,
    );
  }
}
