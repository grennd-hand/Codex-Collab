import { DEFAULT_CODEX_PROMPT_OPTIONS } from "@codex-collab/protocol";
import { describe, expect, it } from "vitest";
import {
  codexComposerStorageKey,
  completeCodexComposerTaskSubmission,
  loadCodexComposerTaskState,
  loadSessionChatDraft,
  persistCodexComposerTaskState,
  persistSessionChatDraft,
} from "./composer-scope.js";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("task-scoped Codex composer state", () => {
  it("creates a different storage identity for each selected task", () => {
    expect(codexComposerStorageKey("composer:session-1", "thread/a")).toBe(
      "composer:session-1:codex:thread%2Fa",
    );
    expect(codexComposerStorageKey("composer:session-1", "thread-b")).toBe(
      "composer:session-1:codex:thread-b",
    );
    expect(codexComposerStorageKey("composer:session-1", null)).toBeNull();
  });

  it("migrates the legacy Codex draft only into the first selected task", () => {
    const storage = new MemoryStorage();
    const sessionKey = "composer:session-1";
    storage.setItem(
      sessionKey,
      JSON.stringify({ codexDraft: "legacy", chatDraft: "room chat" }),
    );

    const first = loadCodexComposerTaskState(
      storage,
      `${sessionKey}:codex:thread-a`,
      sessionKey,
    );
    const second = loadCodexComposerTaskState(
      storage,
      `${sessionKey}:codex:thread-b`,
      sessionKey,
    );

    expect(first.draft).toBe("legacy");
    expect(second.draft).toBe("");
    expect(loadSessionChatDraft(storage, sessionKey)).toBe("room chat");
  });

  it("persists Codex task state independently while chat remains session-scoped", () => {
    const storage = new MemoryStorage();
    const sessionKey = "composer:session-1";
    const firstKey = `${sessionKey}:codex:thread-a`;
    const secondKey = `${sessionKey}:codex:thread-b`;
    persistSessionChatDraft(storage, sessionKey, "shared chat");
    persistCodexComposerTaskState(storage, firstKey, {
      codexOptions: DEFAULT_CODEX_PROMPT_OPTIONS,
      draft: "task A",
      pendingAttachments: [],
    });
    persistCodexComposerTaskState(storage, secondKey, {
      codexOptions: DEFAULT_CODEX_PROMPT_OPTIONS,
      draft: "task B",
      pendingAttachments: [],
    });

    expect(loadCodexComposerTaskState(storage, firstKey, sessionKey).draft).toBe(
      "task A",
    );
    expect(loadCodexComposerTaskState(storage, secondKey, sessionKey).draft).toBe(
      "task B",
    );
    expect(loadSessionChatDraft(storage, sessionKey)).toBe("shared chat");
  });

  it("completes only the submitted task snapshot", () => {
    const firstAttachment = { id: "sent" } as never;
    const secondAttachment = { id: "new" } as never;
    const state = {
      codexOptions: DEFAULT_CODEX_PROMPT_OPTIONS,
      draft: "new edit while sending",
      pendingAttachments: [firstAttachment, secondAttachment],
    };

    expect(
      completeCodexComposerTaskSubmission(state, "submitted draft", ["sent"]),
    ).toEqual({
      ...state,
      pendingAttachments: [secondAttachment],
    });
    expect(
      completeCodexComposerTaskSubmission(
        { ...state, draft: "submitted draft" },
        "submitted draft",
        ["sent"],
      ).draft,
    ).toBe("");
  });
});
