import { hostname } from "node:os";
import { basename } from "node:path";
import type {
  CodexThreadCatalogEntry,
  Message,
} from "@codex-collab/protocol";
import {
  CodexAppServerClient,
  readCodexThreadRevision,
  type CodexThreadSummary,
} from "./app-server-client.js";
import { FileSandbox } from "./file-sandbox.js";
import { LocalProfileStore, type LocalProfile } from "./local-profile.js";
import { RelayClient } from "./relay-client.js";
import {
  buildCodexConfigSnapshot,
  buildWorkspaceSnapshot,
} from "./workspace-snapshot.js";
import {
  shouldPublishWorkspaceSnapshot,
  shouldReadWorkspaceHistory,
  nextPendingCodexCommand,
  workspaceHistoryDigest,
  type WorkspaceSyncMarker,
} from "./workspace-sync.js";

export interface WorkspaceSyncResult {
  selectedThreadId: string | null;
  syncedAt: string | null;
  historyCount: number;
  fileCount: number;
}

function catalogEntry(thread: CodexThreadSummary): CodexThreadCatalogEntry {
  return {
    id: thread.id,
    name: thread.name ?? null,
    preview: thread.preview?.trim().slice(0, 1_000) ?? "",
    updatedAt:
      typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt)
        ? thread.updatedAt
        : null,
  };
}

function catalogsMatch(
  current: readonly CodexThreadCatalogEntry[],
  next: readonly CodexThreadCatalogEntry[],
): boolean {
  return (
    current.length === next.length &&
    current.every((thread, index) => {
      const candidate = next[index];
      return (
        candidate !== undefined &&
        thread.id === candidate.id &&
        thread.name === candidate.name &&
        thread.preview === candidate.preview &&
        thread.updatedAt === candidate.updatedAt
      );
    })
  );
}

function stringListsMatch(
  current: readonly string[] | undefined,
  next: readonly string[],
): boolean {
  return (
    current !== undefined &&
    current.length === next.length &&
    current.every((value, index) => value === next[index])
  );
}

function hasInFlightCodexCommand(messages: readonly Message[]): boolean {
  return messages.some(
    (message) =>
      (message.kind === "codex_prompt" || message.kind === "codex_stop") &&
      (message.deliveryStatus === "queued" || message.deliveryStatus === "submitted"),
  );
}

export async function forwardNextCodexPrompt(
  profile: LocalProfile,
  threadId: string,
  relay: Pick<
    RelayClient,
    "listMessages" | "readMessageAttachment" | "updateMessageDeliveryStatus"
  >,
  codex: Pick<
    CodexAppServerClient,
    "submitPeerPrompt" | "stopPeerPrompt"
  >,
  profiles: Pick<LocalProfileStore, "update">,
  threadBusy = false,
): Promise<string | null> {
  const messages = await relay.listMessages(profile.sessionId, profile.memberToken);
  const forwardedMessageIds = profile.forwardedMessageIds ?? [];
  const pendingCommand = nextPendingCodexCommand(
    messages,
    forwardedMessageIds,
  );
  if (!pendingCommand) {
    return null;
  }
  const forwarded = new Set(forwardedMessageIds);
  const submittedCommand = messages.some(
    (message) =>
      (message.kind === "codex_prompt" || message.kind === "codex_stop") &&
      message.deliveryStatus === "submitted",
  );
  const pendingStop = messages.find(
    (message) =>
      message.kind === "codex_stop" &&
      message.deliveryStatus === "queued" &&
      !forwarded.has(message.id),
  );
  const pendingPrompt =
    threadBusy || submittedCommand
      ? pendingStop ?? null
      : pendingCommand;
  if (!pendingPrompt) return null;

  const submission =
    pendingPrompt.kind === "codex_stop"
      ? await codex.stopPeerPrompt({ threadId })
      : await codex.submitPeerPrompt({
          threadId,
          projectRoot: profile.projectRoot,
          commandId: pendingPrompt.id,
          peerDisplayName: pendingPrompt.senderDisplayName,
          body: pendingPrompt.body,
          attachments: await Promise.all(
            pendingPrompt.attachments.map(async (attachment) => ({
              name: attachment.name,
              mediaType: attachment.mediaType,
              content: await relay.readMessageAttachment(
                profile.sessionId,
                profile.memberToken,
                pendingPrompt.id,
                attachment,
              ),
            })),
          ),
          codexOptions: pendingPrompt.codexOptions ?? {
            accessMode: "follow-desktop",
            customPermissions: null,
            model: null,
            reasoningEffort: "follow-desktop",
            speed: "follow-desktop",
            planMode: false,
          },
        });
  if (submission.status !== "submitted") {
    return null;
  }
  await profiles.update({
    forwardedMessageIds: [
      ...(profile.forwardedMessageIds ?? []),
      pendingPrompt.id,
    ],
  });
  await relay.updateMessageDeliveryStatus(
    profile.sessionId,
    profile.memberToken,
    pendingPrompt.id,
    "submitted",
    submission.turnId ?? null,
  );
  return pendingPrompt.id;
}

export async function reconcileCodexCommandStatuses(
  profile: LocalProfile,
  threadId: string,
  relay: Pick<RelayClient, "listMessages" | "updateMessageDeliveryStatus">,
  codex: Pick<CodexAppServerClient, "getTurnStatus">,
  threadBusy = true,
): Promise<number> {
  const messages = await relay.listMessages(profile.sessionId, profile.memberToken);
  const tracked = messages.filter(
    (message) =>
      (message.kind === "codex_prompt" || message.kind === "codex_stop") &&
      message.deliveryStatus === "submitted",
  );
  const statuses = new Map<string, Awaited<ReturnType<CodexAppServerClient["getTurnStatus"]>>>();
  const latestTrackedId = tracked.at(-1)?.id ?? null;
  const latestTrackedPromptId =
    tracked.findLast((message) => message.kind === "codex_prompt")?.id ?? null;
  const stoppedTurnIds = new Set(
    messages
      .filter(
        (message) =>
          message.kind === "codex_stop" &&
          message.codexTurnId &&
          (message.deliveryStatus === "submitted" ||
            message.deliveryStatus === "completed"),
      )
      .map((message) => message.codexTurnId as string),
  );
  let updated = 0;

  for (const message of tracked) {
    const turnId = message.codexTurnId;
    let status = turnId ? statuses.get(turnId) : null;
    if (turnId && status === undefined) {
      status = await codex.getTurnStatus(threadId, turnId);
      statuses.set(turnId, status);
    }
    let deliveryStatus: "completed" | "failed" | null = null;
    if (status === "completed") {
      deliveryStatus = "completed";
    } else if (message.kind === "codex_stop") {
      if (status === "interrupted") {
        deliveryStatus = "completed";
      } else if (status === "failed") {
        deliveryStatus = "failed";
      }
    } else if (
      (status === "failed" || status === "interrupted") &&
      (!threadBusy ||
        message.id !== latestTrackedPromptId ||
        (turnId !== null && stoppedTurnIds.has(turnId)))
    ) {
      deliveryStatus = "failed";
    } else if (
      status === null &&
      message.kind === "codex_prompt" &&
      turnId !== null &&
      stoppedTurnIds.has(turnId)
    ) {
      deliveryStatus = "failed";
    }
    if (
      !deliveryStatus &&
      status === null &&
      (!threadBusy ||
        (tracked.length > 1 && message.id !== latestTrackedId))
    ) {
      deliveryStatus = "completed";
    }
    if (!deliveryStatus) continue;
    await relay.updateMessageDeliveryStatus(
      profile.sessionId,
      profile.memberToken,
      message.id,
      deliveryStatus,
      turnId ?? null,
    );
    updated += 1;
  }

  return updated;
}

export class WorkspaceSyncService {
  private active = false;
  private forwarding: Promise<string | null> | null = null;
  private marker: WorkspaceSyncMarker | null = null;
  private filesDirty = false;

  constructor(
    private readonly profiles: LocalProfileStore,
    private readonly codex: CodexAppServerClient,
  ) {}

  async forwardPendingCommand(): Promise<string | null> {
    const profile = await this.profiles.read();
    if (!profile || profile.role !== "owner") return null;
    const relay = new RelayClient(profile.relayUrl);
    const workspace = await relay.getWorkspace(
      profile.sessionId,
      profile.memberToken,
    );
    if (!workspace.selectedThreadId) return null;
    const sandbox = await FileSandbox.create(profile.projectRoot);
    const localThreads = await this.codex.listThreads(sandbox.getRoot());
    const selectedLocalThread = localThreads.find(
      (thread) => thread.id === workspace.selectedThreadId,
    );
    if (!selectedLocalThread) {
      throw new Error(
        "Selected Codex task no longer belongs to the explicitly shared root",
      );
    }
    const runtimeBusy = await this.codex.isThreadBusyForPrompt(
      workspace.selectedThreadId,
      selectedLocalThread.path,
    );
    return this.forwardValidatedCommand(
      profile,
      workspace.selectedThreadId,
      relay,
      runtimeBusy,
    );
  }

  async sync(force = false): Promise<WorkspaceSyncResult> {
    if (this.active) {
      return { selectedThreadId: null, syncedAt: null, historyCount: 0, fileCount: 0 };
    }
    this.active = true;
    try {
      const profile = await this.profiles.read();
      if (!profile || profile.role !== "owner") {
        return { selectedThreadId: null, syncedAt: null, historyCount: 0, fileCount: 0 };
      }
      const relay = new RelayClient(profile.relayUrl);
      let workspace = await relay.getWorkspace(profile.sessionId, profile.memberToken);
      const sandbox = await FileSandbox.create(profile.projectRoot);
      const localThreads = await this.codex.listThreads(sandbox.getRoot());
      const catalog = localThreads.map(catalogEntry);
      const localThreadIds = localThreads.map((thread) => thread.id);
      const observedThreadIds = profile.observedThreadIds;
      const observed = new Set(observedThreadIds ?? []);
      const needsCatalogMigration = (profile.threadCatalogVersion ?? 0) < 1;
      const migrationThread =
        needsCatalogMigration && workspace.selectedThreadId ? localThreads[0] ?? null : null;
      const newestDiscoveredThread =
        migrationThread && migrationThread.id !== workspace.selectedThreadId
          ? migrationThread
          : observedThreadIds === undefined
            ? null
            : localThreads.find((thread) => !observed.has(thread.id)) ?? null;
      if (!catalogsMatch(workspace.threads, catalog)) {
        workspace = await relay.publishWorkspaceCatalog(
          profile.sessionId,
          profile.memberToken,
          {
            deviceLabel: hostname(),
            rootLabel: basename(sandbox.getRoot()) || sandbox.getRoot(),
            threads: catalog,
          },
        );
      }

      let selectedLocalThread = localThreads.find(
        (thread) => thread.id === workspace.selectedThreadId,
      );
      let selectedRuntimeBusy: boolean | undefined;
      let selectionDeferred = false;

      if (
        newestDiscoveredThread &&
        newestDiscoveredThread.id !== workspace.selectedThreadId
      ) {
        if (selectedLocalThread && workspace.selectedThreadId) {
          selectedRuntimeBusy = await this.codex.isThreadBusyForPrompt(
            workspace.selectedThreadId,
            selectedLocalThread.path,
          );
          selectionDeferred = selectedRuntimeBusy;
          if (!selectionDeferred) {
            selectionDeferred = hasInFlightCodexCommand(
              await relay.listMessages(profile.sessionId, profile.memberToken),
            );
          }
        }
        if (!selectionDeferred) {
          workspace = await relay.selectWorkspaceThread(
            profile.sessionId,
            profile.memberToken,
            newestDiscoveredThread.id,
          );
          selectedLocalThread = newestDiscoveredThread;
          selectedRuntimeBusy = undefined;
          this.marker = null;
          this.filesDirty = false;
        }
      }

      if (
        !selectionDeferred &&
        (needsCatalogMigration || !stringListsMatch(observedThreadIds, localThreadIds))
      ) {
        await this.profiles.update({
          observedThreadIds: localThreadIds,
          threadCatalogVersion: 1,
        });
      }

      if (!workspace.selectedThreadId) {
        this.marker = null;
        this.filesDirty = false;
        return {
          selectedThreadId: workspace.selectedThreadId,
          syncedAt: workspace.syncedAt,
          historyCount: workspace.history.length,
          fileCount: workspace.files.length,
        };
      }

      if (!selectedLocalThread) {
        throw new Error("Selected Codex task no longer belongs to the explicitly shared root");
      }

      const runtimeBusy = selectedRuntimeBusy ??
        (await this.codex.isThreadBusyForPrompt(
          workspace.selectedThreadId,
          selectedLocalThread.path,
        ));
      await reconcileCodexCommandStatuses(
        profile,
        workspace.selectedThreadId,
        relay,
        this.codex,
        runtimeBusy,
      );
      const forwardedCommandId = await this.forwardValidatedCommand(
        profile,
        workspace.selectedThreadId,
        relay,
        runtimeBusy,
      );
      await relay.publishCodexRuntimeStatus(
        profile.sessionId,
        profile.memberToken,
        runtimeBusy || Boolean(forwardedCommandId) ? "running" : "idle",
      );
      const runtimeRunning = runtimeBusy || Boolean(forwardedCommandId);

      const revision = await readCodexThreadRevision(selectedLocalThread);
      const syncState = {
        force,
        sessionId: profile.sessionId,
        threadId: workspace.selectedThreadId,
        syncedAt: workspace.syncedAt,
        revision,
        marker: this.marker,
      };
      const historyChanged = shouldReadWorkspaceHistory(syncState);
      const shouldFinalizeFiles = !runtimeRunning && this.filesDirty;
      if (!historyChanged && !shouldFinalizeFiles) {
        return {
          selectedThreadId: workspace.selectedThreadId,
          syncedAt: workspace.syncedAt,
          historyCount: workspace.history.length,
          fileCount: workspace.files.length,
        };
      }

      const history = historyChanged
        ? await this.codex.readThreadHistory(
            workspace.selectedThreadId,
            selectedLocalThread.path,
          )
        : workspace.history;
      const historyDigest = workspaceHistoryDigest(history);
      const historyNeedsPublish =
        historyChanged &&
        shouldPublishWorkspaceSnapshot(syncState, historyDigest);
      if (!historyNeedsPublish && !shouldFinalizeFiles) {
        this.marker = {
          sessionId: profile.sessionId,
          threadId: workspace.selectedThreadId,
          revision,
          historyDigest,
        };
        return {
          selectedThreadId: workspace.selectedThreadId,
          syncedAt: workspace.syncedAt,
          historyCount: workspace.history.length,
          fileCount: workspace.files.length,
        };
      }

      if (runtimeRunning && workspace.syncedAt && !force) {
        const imported = await relay.publishWorkspaceHistory(
          profile.sessionId,
          profile.memberToken,
          {
            threadId: workspace.selectedThreadId,
            history,
          },
        );
        this.marker = {
          sessionId: profile.sessionId,
          threadId: workspace.selectedThreadId,
          revision,
          historyDigest,
        };
        this.filesDirty = true;
        await this.profiles.update({ threadId: workspace.selectedThreadId });
        return {
          selectedThreadId: imported.selectedThreadId,
          syncedAt: imported.syncedAt,
          historyCount: imported.history.length,
          fileCount: imported.files.length,
        };
      }

      const codexConfigSandbox = profile.codexConfigRoot
        ? await FileSandbox.create(profile.codexConfigRoot)
        : null;
      const [projectFiles, codexConfigFiles] = await Promise.all([
        buildWorkspaceSnapshot(sandbox),
        codexConfigSandbox
          ? buildCodexConfigSnapshot(codexConfigSandbox)
          : Promise.resolve([]),
      ]);
      const imported = await relay.publishWorkspaceSnapshot(
        profile.sessionId,
        profile.memberToken,
        {
          threadId: workspace.selectedThreadId,
          history,
          files: [...projectFiles, ...codexConfigFiles],
        },
      );
      this.marker = {
        sessionId: profile.sessionId,
        threadId: workspace.selectedThreadId,
        revision,
        historyDigest,
      };
      this.filesDirty = runtimeRunning;
      await this.profiles.update({ threadId: workspace.selectedThreadId });
      return {
        selectedThreadId: imported.selectedThreadId,
        syncedAt: imported.syncedAt,
        historyCount: imported.history.length,
        fileCount: imported.files.length,
      };
    } finally {
      this.active = false;
    }
  }

  private forwardValidatedCommand(
    profile: LocalProfile,
    threadId: string,
    relay: RelayClient,
    threadBusy: boolean,
  ): Promise<string | null> {
    if (this.forwarding) return this.forwarding;
    const pending = forwardNextCodexPrompt(
      profile,
      threadId,
      relay,
      this.codex,
      this.profiles,
      threadBusy,
    );
    this.forwarding = pending;
    const clear = () => {
      if (this.forwarding === pending) {
        this.forwarding = null;
      }
    };
    void pending.then(clear, clear);
    return pending;
  }
}
