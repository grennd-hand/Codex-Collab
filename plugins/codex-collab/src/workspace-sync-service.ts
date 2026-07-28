import { hostname } from "node:os";
import { basename } from "node:path";
import {
  type CodexRuntimeStatus,
  type CodexThreadCatalogEntry,
  type Message,
  type WorkspaceSummary,
  type WorkspaceSyncState,
} from "@codex-collab/protocol";
import {
  CodexAppServerClient,
  readCodexThreadRevision,
  type CodexThreadSummary,
} from "./app-server-client.js";
import { LocalProfileStore, type LocalProfile } from "./local-profile.js";
import { RelayClient } from "./relay-client.js";
import { processNextWorkspaceFileOperation } from "./workspace-file-operations.js";
import { cacheNextWorkspaceThreadHistory } from "./workspace-history-backfill.js";
import { openWorkspaceSandboxes } from "./workspace-roots.js";
import {
  buildCodexConfigSnapshot,
  buildWorkspaceSnapshot,
  buildWorkspaceSnapshotManifest,
} from "./workspace-snapshot.js";
import {
  shouldPublishWorkspaceSnapshot,
  shouldReadWorkspaceHistory,
  workspaceHistoryDigest,
  type WorkspaceSyncMarker,
} from "./workspace-sync.js";
import {
  forwardNextCodexPrompt,
  hasInFlightCodexCommand,
  reconcileCodexCommandStatuses,
} from "./codex-command-sync.js";
export {
  forwardNextCodexPrompt,
  reconcileCodexCommandStatuses,
} from "./codex-command-sync.js";

export interface WorkspaceSyncResult {
  selectedThreadId: string | null;
  syncedAt: string | null;
  historyCount: number;
  fileCount: number;
}

function syncStateFromSummary(workspace: WorkspaceSummary): WorkspaceSyncState {
  const { history, files, ...state } = workspace;
  return {
    ...state,
    historyCount: history.length,
    fileCount: files.length,
  };
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

export class WorkspaceSyncService {
  private active = false;
  private forwarding: Promise<string | null> | null = null;
  private marker: WorkspaceSyncMarker | null = null;
  private workspaceDigest: string | null = null;
  private filesDirty = false;
  private processingFileOperations: Promise<number> | null = null;

  constructor(
    private readonly profiles: LocalProfileStore,
    private readonly codex: CodexAppServerClient,
  ) {}

  async forwardPendingCommand(): Promise<string | null> {
    const profile = await this.profiles.read();
    if (!profile || profile.role !== "owner") return null;
    const relay = new RelayClient(profile.relayUrl);
    const workspace = await relay.getWorkspaceSyncState(
      profile.sessionId,
      profile.memberToken,
    );
    if (!workspace.selectedThreadId) return null;
    const { projectSandbox: sandbox } = await openWorkspaceSandboxes(
      profile.projectRoot,
      profile.codexConfigRoot,
    );
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

  async processPendingFileOperations(): Promise<number> {
    if (this.processingFileOperations) return this.processingFileOperations;
    const pending = (async () => {
      const profile = await this.profiles.read();
      if (!profile || profile.role !== "owner") return 0;
      const relay = new RelayClient(profile.relayUrl);
      const { projectSandbox, codexConfigSandbox } = await openWorkspaceSandboxes(
        profile.projectRoot,
        profile.codexConfigRoot,
      );
      let processed = 0;
      while (processed < 20) {
        const operation = await processNextWorkspaceFileOperation(
          profile.sessionId,
          profile.memberToken,
          relay,
          projectSandbox,
          codexConfigSandbox,
        );
        if (!operation) break;
        processed += 1;
        if (operation.kind !== "read" && operation.status === "completed") {
          this.filesDirty = true;
        }
      }
      return processed;
    })();
    this.processingFileOperations = pending;
    const clear = () => {
      if (this.processingFileOperations === pending) {
        this.processingFileOperations = null;
      }
    };
    void pending.then(clear, clear);
    return pending;
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
      let workspace = await relay.getWorkspaceSyncState(
        profile.sessionId,
        profile.memberToken,
      );
      const { projectSandbox: sandbox, codexConfigSandbox } =
        await openWorkspaceSandboxes(profile.projectRoot, profile.codexConfigRoot);
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
        workspace = syncStateFromSummary(
          await relay.publishWorkspaceCatalog(
            profile.sessionId,
            profile.memberToken,
            {
              deviceLabel: hostname(),
              rootLabel: basename(sandbox.getRoot()) || sandbox.getRoot(),
              threads: catalog,
            },
          ),
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
          workspace = syncStateFromSummary(
            await relay.selectWorkspaceThread(
              profile.sessionId,
              profile.memberToken,
              newestDiscoveredThread.id,
            ),
          );
          selectedLocalThread = newestDiscoveredThread;
          selectedRuntimeBusy = undefined;
          this.marker = null;
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
        this.workspaceDigest = null;
        this.filesDirty = false;
        return {
          selectedThreadId: workspace.selectedThreadId,
          syncedAt: workspace.syncedAt,
          historyCount: workspace.historyCount,
          fileCount: workspace.fileCount,
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
      const relayMessages = await relay.listMessages(
        profile.sessionId,
        profile.memberToken,
      );
      await reconcileCodexCommandStatuses(
        profile,
        workspace.selectedThreadId,
        relay,
        this.codex,
        runtimeBusy,
        relayMessages,
      );
      const forwardedCommandId = await this.forwardValidatedCommand(
        profile,
        workspace.selectedThreadId,
        relay,
        runtimeBusy,
        relayMessages,
      );
      const runtimeRunning = runtimeBusy || Boolean(forwardedCommandId);
      const runtimeStatus: CodexRuntimeStatus = runtimeRunning ? "running" : "idle";
      if (workspace.codexRuntimeStatus !== runtimeStatus) {
        await relay.publishCodexRuntimeStatus(
          profile.sessionId,
          profile.memberToken,
          runtimeStatus,
        );
      }
      await cacheNextWorkspaceThreadHistory(
        profile,
        workspace,
        localThreads,
        this.codex,
        relay,
      );

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
      const manifest = await buildWorkspaceSnapshotManifest(
        sandbox,
        codexConfigSandbox,
      );
      if (this.workspaceDigest === null) {
        this.workspaceDigest = manifest.digest;
      } else if (this.workspaceDigest !== manifest.digest) {
        this.filesDirty = true;
      }
      const shouldFinalizeFiles = !runtimeRunning && this.filesDirty;
      if (!historyChanged && !shouldFinalizeFiles) {
        return {
          selectedThreadId: workspace.selectedThreadId,
          syncedAt: workspace.syncedAt,
          historyCount: workspace.historyCount,
          fileCount: workspace.fileCount,
        };
      }

      const history = await this.codex.readThreadHistory(
        workspace.selectedThreadId,
        selectedLocalThread.path,
      );
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
          historyCount: workspace.historyCount,
          fileCount: workspace.fileCount,
        };
      }

      const canReuseWorkspaceFiles =
        !force && !shouldFinalizeFiles && workspace.fileCount > 0;
      if (
        (runtimeRunning && workspace.syncedAt && !force) ||
        canReuseWorkspaceFiles
      ) {
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
        this.filesDirty = runtimeRunning;
        await this.profiles.update({ threadId: workspace.selectedThreadId });
        return {
          selectedThreadId: imported.selectedThreadId,
          syncedAt: imported.syncedAt,
          historyCount: imported.historyCount,
          fileCount: imported.fileCount,
        };
      }

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
          directories: manifest.directories,
        },
      );
      this.marker = {
        sessionId: profile.sessionId,
        threadId: workspace.selectedThreadId,
        revision,
        historyDigest,
      };
      this.workspaceDigest = manifest.digest;
      this.filesDirty = runtimeRunning;
      await this.profiles.update({ threadId: workspace.selectedThreadId });
      return {
        selectedThreadId: imported.selectedThreadId,
        syncedAt: imported.syncedAt,
        historyCount: imported.historyCount,
        fileCount: imported.fileCount,
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
    prefetchedMessages?: Message[],
  ): Promise<string | null> {
    if (this.forwarding) return this.forwarding;
    const pending = forwardNextCodexPrompt(
      profile,
      threadId,
      relay,
      this.codex,
      this.profiles,
      threadBusy,
      prefetchedMessages,
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
