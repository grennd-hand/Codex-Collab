import type { CodexAppServerClient } from "./app-server-client.js";
import {
  recoverCommandReceipt,
  type CommandDelivery,
} from "./command-outbox.js";
import type { LocalProfileStore } from "./local-profile.js";
import { RelayClient } from "./relay-client.js";
import { WorkspaceFileOperationJournal } from "./workspace-file-operation-receipts.js";
import {
  workspaceWorkAllowed,
  type WorkspaceSyncAdmission,
} from "./workspace-sync-admission.js";

export class DurableReceiptReconciler {
  private active: Promise<CommandDelivery | null> | null = null;

  constructor(
    private readonly profiles: LocalProfileStore,
    private readonly codex: CodexAppServerClient,
    private readonly waitForActiveWork: () => Promise<void>,
  ) {}

  async reconcile(admission?: WorkspaceSyncAdmission): Promise<CommandDelivery | null> {
    await this.waitForActiveWork();
    if (!workspaceWorkAllowed(admission)) return null;
    if (this.active) return this.active;
    const pending = this.reconcileOnce(admission);
    this.active = pending;
    const clear = () => {
      if (this.active === pending) this.active = null;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async reconcileOnce(
    admission?: WorkspaceSyncAdmission,
  ): Promise<CommandDelivery | null> {
    const profile = await this.profiles.read();
    if (!profile || profile.role !== "owner" || !workspaceWorkAllowed(admission)) {
      return null;
    }
    const relay = new RelayClient(profile.relayUrl);
    const recovered = await recoverCommandReceipt(
      profile,
      relay,
      this.codex,
      this.profiles,
    );
    if (!workspaceWorkAllowed(admission)) return recovered;
    await new WorkspaceFileOperationJournal(
      this.profiles,
      profile,
    ).reconcileBeforeClaim(relay);
    return recovered;
  }
}
