import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import {
  type CodexPromptOptions,
  type CodexRecordEntry,
} from "@codex-collab/protocol";
import { CodexDesktopIpcClient } from "./codex-desktop-ipc-client.js";
import { findPeerPromptTurnIds } from "./app-server/command-correlation.js";
import { JsonRpcTransport } from "./app-server/json-rpc-transport.js";
import {
  buildCodexTurnStartParams,
  decodeInlineTextAttachment,
  delay,
  isEmptyRolloutError,
  isUnmaterializedThreadError,
  isUnsupportedClientUserMessageIdError,
  nestedTurnId,
  type CodexUserInput,
} from "./app-server/prompt-submission.js";
import {
  extractCodexRecordEntries,
  isCodexThreadBusy,
  type CodexRolloutActivity,
  type CodexThreadSummary,
  type CodexTurn,
  type CodexTurnStatus,
} from "./app-server/thread-history-parser.js";
import { extractCodexRolloutEntries } from "./app-server/rollout-history-parser.js";
import { RolloutHistorySource } from "./app-server/rollout-history-source.js";
import { RolloutActivityReader } from "./app-server/rollout-activity-reader.js";
import { readCodexTurns } from "./app-server/thread-turn-reader.js";

export type {
  CodexThreadSummary,
  CodexTurnStatus,
} from "./app-server/thread-history-parser.js";
export {
  buildCodexTurnStartParams,
  decodeInlineTextAttachment,
} from "./app-server/prompt-submission.js";
export {
  extractCodexRecordEntries,
  extractCodexRolloutActivity,
  isCodexThreadBusy,
  readCodexThreadRevision,
} from "./app-server/thread-history-parser.js";
export {
  extractCodexRolloutEntries,
} from "./app-server/rollout-history-parser.js";

export interface CodexPromptSubmission {
  status: "submitted" | "deferred";
  reason?: string | null;
  mode?: "started" | "steered" | "interrupted";
  turnId?: string | null;
}

interface ThreadResumeResponse {
  thread?: unknown;
  model?: string | null;
  reasoningEffort?: string | null;
}

interface TurnStartResponse {
  turn?: { id?: string };
}

type CodexDesktopBridge = Pick<
  CodexDesktopIpcClient,
  "startTurn" | "steerTurn" | "interruptTurn" | "close"
>;

export interface CodexAppServerClientOptions {
  desktopIpc?: CodexDesktopBridge;
  platform?: NodeJS.Platform;
}

export class CodexAppServerClient extends EventEmitter {
  private readonly transport = new JsonRpcTransport();
  private readonly rolloutActivityReader = new RolloutActivityReader();
  private readonly rolloutHistorySource = new RolloutHistorySource();
  private started = false;
  private readonly stagedAttachments = new Map<string, Set<string>>();
  private readonly desktopIpc: CodexDesktopBridge;
  private readonly platform: NodeJS.Platform;

  constructor(options: CodexAppServerClientOptions = {}) {
    super();
    this.desktopIpc = options.desktopIpc ?? new CodexDesktopIpcClient();
    this.platform = options.platform ?? process.platform;
    this.transport.on("diagnostic", (text) => this.emit("diagnostic", text));
    this.transport.on("exit", () => {
      this.started = false;
      void this.cleanupAllStagedAttachments();
    });
    this.transport.on("notification", (message) => {
      const notification = message as { method?: string; params?: unknown };
      if (
        notification.method === "turn/completed" &&
        notification.params &&
        typeof notification.params === "object" &&
        "turn" in notification.params &&
        notification.params.turn &&
        typeof notification.params.turn === "object" &&
        "id" in notification.params.turn &&
        typeof notification.params.turn.id === "string"
      ) {
        void this.cleanupStagedAttachments(notification.params.turn.id);
      }
      this.emit("notification", notification);
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.transport.start();
    await this.transport.request("initialize", {
      clientInfo: {
        name: "codex-collab",
        title: "Codex Collab host bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.transport.notify("initialized");
    this.started = true;
  }

  async listThreads(cwd?: string): Promise<CodexThreadSummary[]> {
    await this.start();
    const response = (await this.request("thread/list", {
      limit: 50,
      archived: false,
      sortKey: "updated_at",
      sortDirection: "desc",
      ...(cwd ? { cwd } : {}),
    })) as { data?: CodexThreadSummary[] };
    return response.data ?? [];
  }

  async readThreadHistory(
    threadId: string,
    rolloutPath?: string | null,
  ): Promise<CodexRecordEntry[]> {
    await this.start();
    const rolloutHistory = await this.rolloutHistorySource.read(threadId, rolloutPath);
    if (rolloutHistory !== null) return rolloutHistory;
    const turns = await readCodexTurns(
      (method, params) => this.request(method, params),
      threadId,
      1_000,
    );
    return extractCodexRecordEntries(turns, threadId);
  }

  async findPeerPromptTurnIds(
    threadId: string,
    commandId: string,
  ): Promise<string[]> {
    await this.start();
    return findPeerPromptTurnIds(
      (method, params) => this.request(method, params),
      threadId,
      commandId,
    );
  }

  async isThreadBusyForPrompt(
    threadId: string,
    rolloutPath?: string | null,
  ): Promise<boolean> {
    await this.start();
    await this.request("thread/resume", {
      threadId,
      excludeTurns: true,
    });
    const response = (await this.request("thread/turns/list", {
      threadId,
      limit: 50,
      sortDirection: "desc",
      itemsView: "summary",
    })) as { data?: CodexTurn[] };

    let activity: CodexRolloutActivity = {
      openTurnIds: [],
      latestObservedTurnId: null,
      latestObservedAtMs: null,
    };
    if (
      rolloutPath &&
      isAbsolute(rolloutPath) &&
      extname(rolloutPath).toLowerCase() === ".jsonl" &&
      basename(rolloutPath).includes(threadId)
    ) {
      const resolved = await realpath(rolloutPath);
      const metadata = await stat(resolved);
      if (metadata.isFile()) {
        activity = await this.rolloutActivityReader.read(resolved, metadata.size);
      }
    }

    return isCodexThreadBusy(activity, response.data ?? []);
  }

  async submitPeerPrompt(input: {
    threadId: string;
    projectRoot: string;
    commandId: string;
    requesterMemberId: string;
    ownerMemberId: string;
    peerDisplayName: string;
    body: string;
    attachments: Array<{
      name: string;
      mediaType: string;
      content: Uint8Array;
    }>;
    codexOptions: CodexPromptOptions;
  }): Promise<CodexPromptSubmission> {
    await this.start();
    const preparedAttachments = input.attachments.map((attachment) => ({
      attachment,
      inlineText: decodeInlineTextAttachment(attachment),
    }));
    let stagingDirectory: string | null = null;
    if (preparedAttachments.some((entry) => entry.inlineText === null)) {
      const approvedRoot = await realpath(input.projectRoot);
      const stagingRoot = join(approvedRoot, ".codex-collab");
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      stagingDirectory = await mkdtemp(join(stagingRoot, "attachments-"));
    }
    const userInput: CodexUserInput[] = [
      { type: "text", text: input.body, text_elements: [] },
    ];
    let stagingRegistered = false;
    try {
      for (const [index, prepared] of preparedAttachments.entries()) {
        const { attachment, inlineText } = prepared;
        if (inlineText !== null) {
          userInput.push({
            type: "text",
            text: `\n\nAttached file: ${attachment.name}\n${inlineText}`,
            text_elements: [],
          });
          continue;
        }
        if (stagingDirectory) {
          const path = join(
            stagingDirectory,
            `${String(index + 1).padStart(2, "0")}-${basename(attachment.name)}`,
          );
          await writeFile(path, attachment.content, { mode: 0o600 });
          userInput.push(
            attachment.mediaType.startsWith("image/")
              ? { type: "localImage", path, detail: "auto" }
              : { type: "mention", name: attachment.name, path },
          );
        }
      }

      const activeTurnId = await this.getActiveTurnId(input.threadId);
      if (activeTurnId) {
        return {
          status: "deferred",
          reason: "active-turn",
          turnId: activeTurnId,
        };
      }

      let resumed: ThreadResumeResponse = {};
      try {
        resumed = (await this.request("thread/resume", {
          threadId: input.threadId,
          excludeTurns: true,
        })) as ThreadResumeResponse;
      } catch (error) {
        if (!isUnmaterializedThreadError(error)) throw error;
      }
      const startParameters = buildCodexTurnStartParams({
        threadId: input.threadId,
        userInput,
        attachmentMediaTypes: input.attachments.map(
          (attachment) => attachment.mediaType,
        ),
        options: input.codexOptions,
        currentModel: resumed.model ?? null,
        currentReasoningEffort: resumed.reasoningEffort ?? null,
        peerDisplayName: input.peerDisplayName,
        commandId: input.commandId,
        ownerAuthored: input.requesterMemberId === input.ownerMemberId,
      });
      let turnId: string | null = null;
      try {
        if (this.platform === "win32") {
          const { threadId: _threadId, ...turnStartParams } = startParameters;
          const response = await this.desktopIpc.startTurn({
            conversationId: input.threadId,
            turnStartParams: {
              ...turnStartParams,
              additionalContext: null,
            },
          });
          turnId = nestedTurnId(response);
        } else {
          const response = (await this.request(
            "turn/start",
            startParameters,
          )) as TurnStartResponse;
          turnId = response.turn?.id ?? null;
        }
      } catch (error) {
        if (isUnsupportedClientUserMessageIdError(error)) {
          throw new Error(
            "Codex does not support durable clientUserMessageId correlation; the prompt was not retried",
            { cause: error },
          );
        }
        throw error;
      }
      if (!turnId) {
        throw new Error("Codex Desktop did not return a started turn id");
      }
      if (stagingDirectory) {
        this.registerStagingDirectory(turnId, stagingDirectory);
        stagingRegistered = true;
      }
      return { status: "submitted", mode: "started", turnId };
    } finally {
      if (stagingDirectory && !stagingRegistered) {
        await rm(stagingDirectory, { recursive: true, force: true });
      }
    }
  }

  async stopPeerPrompt(input: {
    threadId: string;
  }): Promise<CodexPromptSubmission> {
    await this.start();
    let desktopError: unknown = null;
    if (this.platform === "win32") {
      try {
        const result = await this.desktopIpc.interruptTurn({
          conversationId: input.threadId,
          mode: "user-stop",
        });
        if (result.interruptedTurnId) {
          return {
            status: "submitted",
            mode: "interrupted",
            turnId: result.interruptedTurnId,
          };
        }
      } catch (error) {
        desktopError = error;
      }
    }

    const turnId = await this.getActiveTurnId(input.threadId);
    if (!turnId) {
      if (desktopError) throw desktopError;
      return { status: "deferred", reason: "no-active-turn", turnId: null };
    }

    try {
      await this.request("thread/resume", {
        threadId: input.threadId,
        excludeTurns: true,
      });
      await this.request("turn/interrupt", {
        threadId: input.threadId,
        turnId,
      });
      await this.waitForTurnInterruption(input.threadId, turnId);
    } catch (error) {
      if (desktopError) {
        throw new AggregateError(
          [desktopError, error],
          "Codex Desktop IPC and app-server both failed to interrupt the active turn",
        );
      }
      throw error;
    }

    return { status: "submitted", mode: "interrupted", turnId };
  }

  async getTurnStatus(
    threadId: string,
    turnId: string,
  ): Promise<CodexTurnStatus | null> {
    await this.start();
    const response = (await this.request("thread/turns/list", {
      threadId,
      limit: 100,
      sortDirection: "desc",
      itemsView: "summary",
    })) as { data?: CodexTurn[] };
    return response.data?.find((turn) => turn.id === turnId)?.status ?? null;
  }

  private async getActiveTurnId(threadId: string): Promise<string | null> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const response = (await this.request("thread/turns/list", {
          threadId,
          limit: 50,
          sortDirection: "desc",
          itemsView: "summary",
        })) as { data?: CodexTurn[] };
        return response.data?.find((turn) => turn.status === "inProgress")?.id ?? null;
      } catch (error) {
        if (isUnmaterializedThreadError(error)) return null;
        if (isEmptyRolloutError(error) && attempt < 9) {
          await delay(100);
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  private async waitForTurnInterruption(
    threadId: string,
    turnId: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await this.getTurnStatus(threadId, turnId);
      if (
        status === "interrupted" ||
        status === "failed" ||
        status === "completed"
      ) {
        return;
      }
      if (attempt < 19) {
        await delay(100);
      }
    }
    throw new Error(
      `Codex app-server did not confirm interruption of turn ${turnId}`,
    );
  }

  private registerStagingDirectory(turnId: string, path: string): void {
    const paths = this.stagedAttachments.get(turnId) ?? new Set<string>();
    paths.add(path);
    this.stagedAttachments.set(turnId, paths);
    const fallback = setTimeout(() => {
      void this.cleanupStagedAttachments(turnId);
    }, 60 * 60 * 1_000);
    fallback.unref();
  }

  private async cleanupStagedAttachments(turnId: string): Promise<void> {
    const paths = this.stagedAttachments.get(turnId);
    if (!paths) return;
    this.stagedAttachments.delete(turnId);
    await Promise.all(
      [...paths].map((path) => rm(path, { recursive: true, force: true })),
    );
  }

  private async cleanupAllStagedAttachments(): Promise<void> {
    const turnIds = [...this.stagedAttachments.keys()];
    await Promise.all(
      turnIds.map((turnId) => this.cleanupStagedAttachments(turnId)),
    );
  }

  async close(): Promise<void> {
    this.transport.close();
    this.started = false;
    await this.desktopIpc.close();
    await this.cleanupAllStagedAttachments();
    this.rolloutActivityReader.clear();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return this.transport.request(method, params);
  }

}
