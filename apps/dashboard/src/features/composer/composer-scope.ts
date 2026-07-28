import type { CodexPromptOptions } from "@codex-collab/protocol";
import {
  DEFAULT_CODEX_PROMPT_OPTIONS,
} from "@codex-collab/protocol";
import type { PendingAttachment } from "./attachments.js";
import { normalizeCodexOptionsForUi } from "./codex-controls.js";

export type CodexComposerTaskState = {
  codexOptions: CodexPromptOptions;
  draft: string;
  pendingAttachments: PendingAttachment[];
};

type PersistedComposerState = {
  chatDraft?: unknown;
  codexDraft?: unknown;
  codexOptions?: unknown;
  composerMode?: unknown;
  draft?: unknown;
};

export function codexComposerStorageKey(
  sessionStorageKey: string | null,
  selectedThreadId: string | null,
): string | null {
  const threadId = selectedThreadId?.trim();
  return sessionStorageKey && threadId
    ? `${sessionStorageKey}:codex:${encodeURIComponent(threadId)}`
    : null;
}

export function emptyCodexComposerTaskState(): CodexComposerTaskState {
  return {
    codexOptions: DEFAULT_CODEX_PROMPT_OPTIONS,
    draft: "",
    pendingAttachments: [],
  };
}

function parseStoredComposer(storage: Storage, key: string): PersistedComposerState {
  try {
    const saved = JSON.parse(storage.getItem(key) ?? "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved)
      ? (saved as PersistedComposerState)
      : {};
  } catch {
    return {};
  }
}

function storedCodexState(saved: PersistedComposerState): CodexComposerTaskState {
  const legacyDraft = typeof saved.draft === "string" ? saved.draft : "";
  return {
    codexOptions:
      saved.codexOptions &&
      typeof saved.codexOptions === "object" &&
      !Array.isArray(saved.codexOptions)
        ? normalizeCodexOptionsForUi(saved.codexOptions)
        : DEFAULT_CODEX_PROMPT_OPTIONS,
    draft:
      typeof saved.codexDraft === "string"
        ? saved.codexDraft
        : saved.composerMode === "chat"
          ? ""
          : legacyDraft,
    pendingAttachments: [],
  };
}

export function loadCodexComposerTaskState(
  storage: Storage,
  taskStorageKey: string,
  sessionStorageKey: string,
): CodexComposerTaskState {
  if (storage.getItem(taskStorageKey) !== null) {
    return storedCodexState(parseStoredComposer(storage, taskStorageKey));
  }
  const migrationKey = `${sessionStorageKey}:codex-migrated`;
  if (storage.getItem(migrationKey) === null) {
    storage.setItem(migrationKey, taskStorageKey);
    return storedCodexState(parseStoredComposer(storage, sessionStorageKey));
  }
  return emptyCodexComposerTaskState();
}

export function persistCodexComposerTaskState(
  storage: Storage,
  taskStorageKey: string,
  state: CodexComposerTaskState,
): void {
  storage.setItem(
    taskStorageKey,
    JSON.stringify({ codexDraft: state.draft, codexOptions: state.codexOptions }),
  );
}

export function completeCodexComposerTaskSubmission(
  state: CodexComposerTaskState,
  submittedDraft: string,
  submittedAttachmentIds: readonly string[],
): CodexComposerTaskState {
  const submittedIds = new Set(submittedAttachmentIds);
  return {
    ...state,
    draft: state.draft === submittedDraft ? "" : state.draft,
    pendingAttachments: state.pendingAttachments.filter(
      (attachment) => !submittedIds.has(attachment.id),
    ),
  };
}

export function loadSessionChatDraft(storage: Storage, storageKey: string): string {
  const saved = parseStoredComposer(storage, storageKey);
  const legacyDraft = typeof saved.draft === "string" ? saved.draft : "";
  return typeof saved.chatDraft === "string"
    ? saved.chatDraft
    : saved.composerMode === "chat"
      ? legacyDraft
      : "";
}

export function persistSessionChatDraft(
  storage: Storage,
  storageKey: string,
  chatDraft: string,
): void {
  const current = parseStoredComposer(storage, storageKey);
  storage.setItem(storageKey, JSON.stringify({ ...current, chatDraft }));
}
