import { describe, expect, it } from "vitest";
import type { CodexRecordEntry, Message } from "@codex-collab/protocol";
import {
  buildImportedTimeline,
  buildUnifiedTimeline,
  executionDetailLabel,
  sanitizeImportedUserText,
  splitConversationMessages,
} from "./imported-timeline.js";

function record(
  id: string,
  role: CodexRecordEntry["role"],
  text = id,
): CodexRecordEntry {
  return { id, role, text, createdAt: null };
}

function message(
  id: string,
  kind: Message["kind"],
  body: string,
  createdAt: string,
): Message {
  return {
    id,
    sessionId: "session-1",
    senderMemberId: "owner-1",
    senderDisplayName: "Owner",
    kind,
    body,
    attachments: [],
    codexOptions: null,
    deliveryStatus: kind === "codex_prompt" ? "submitted" : null,
    codexTurnId: kind === "codex_prompt" ? "turn-1" : null,
    completedAt: null,
    createdAt,
  };
}

describe("buildImportedTimeline", () => {
  it("keeps user and assistant records as visible messages", () => {
    expect(
      buildImportedTimeline([record("user-1", "user"), record("assistant-1", "assistant")]),
    ).toEqual([
      { kind: "message", entry: record("user-1", "user") },
      { kind: "message", entry: record("assistant-1", "assistant") },
    ]);
  });

  it("groups consecutive reasoning and command records", () => {
    const timeline = buildImportedTimeline([
      record("user-1", "user"),
      record("reasoning-1", "reasoning"),
      record("command-1", "command"),
      record("assistant-1", "assistant"),
      record("command-2", "command"),
    ]);

    expect(timeline).toEqual([
      { kind: "message", entry: record("user-1", "user") },
      {
        kind: "execution",
        id: "execution-reasoning-1",
        entries: [record("reasoning-1", "reasoning"), record("command-1", "command")],
      },
      { kind: "message", entry: record("assistant-1", "assistant") },
      {
        kind: "execution",
        id: "execution-command-2",
        entries: [record("command-2", "command")],
      },
    ]);
  });
});

describe("sanitizeImportedUserText", () => {
  it("keeps only the request body from a single-attachment Desktop wrapper", () => {
    const wrapped = [
      "# Files mentioned by the user:",
      "",
      "## screenshot.png:",
      "C:/Users/test/AppData/Local/Temp/screenshot.png",
      "",
      "## My request for Codex:",
      "Fix the command execution.",
    ].join("\n");

    expect(sanitizeImportedUserText(wrapped)).toBe(
      "Fix the command execution.",
    );
  });

  it("removes every attachment block and preserves a Chinese request body", () => {
    const wrapped = [
      "# Files mentioned by the user:",
      "",
      "## first.png:",
      "C:\\Users\\test\\Temp\\first.png",
      "",
      "## second file.txt:",
      "D:/资料/second file.txt",
      "",
      "## My request for Codex:",
      "请修复消息同步。",
      "",
      "不要改动其他页面。",
    ].join("\r\n");

    expect(sanitizeImportedUserText(wrapped)).toBe(
      "请修复消息同步。\n\n不要改动其他页面。",
    );
  });

  it("leaves ordinary Markdown without an attachment wrapper unchanged", () => {
    const markdown = [
      "# Files mentioned by the user:",
      "",
      "这只是普通 Markdown，不是 Desktop 附件包装。",
      "",
      "## My request for Codex:",
      "内容也必须保留。",
    ].join("\n");

    expect(sanitizeImportedUserText(markdown)).toBe(markdown);
  });

  it("leaves an incomplete Desktop wrapper unchanged", () => {
    const incomplete = [
      "# Files mentioned by the user:",
      "",
      "## screenshot.png:",
      "C:/Users/test/Temp/screenshot.png",
    ].join("\n");

    expect(sanitizeImportedUserText(incomplete)).toBe(incomplete);
  });
});

describe("buildUnifiedTimeline", () => {
  it("places the Codex response after its shared command without duplicating the prompt", () => {
    const command = message(
      "prompt-1",
      "codex_prompt",
      "Run the checks",
      "2026-07-25T00:00:00.000Z",
    );
    const timeline = buildUnifiedTimeline(
      [
        {
          id: "user-1",
          role: "user",
          text: [
            "[Codex Collab command: prompt-1]",
            "[Codex Collab member: Owner]",
            "",
            "Run the checks",
          ].join("\n"),
          createdAt: "2026-07-25T00:00:01.000Z",
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: "Checks passed",
          createdAt: "2026-07-25T00:00:01.000Z",
        },
      ],
      [command],
    );

    expect(timeline).toEqual([
      { kind: "shared", message: command },
      {
        kind: "imported",
        item: {
          kind: "message",
          entry: {
            id: "assistant-1",
            role: "assistant",
            text: "Checks passed",
            createdAt: "2026-07-25T00:00:01.000Z",
          },
        },
      },
    ]);
  });

  it("deduplicates a plain Desktop user record by client message id", () => {
    const command = message(
      "prompt-plain",
      "codex_prompt",
      "继续检查",
      "2026-07-25T00:00:00.000Z",
    );
    const timeline = buildUnifiedTimeline(
      [
        {
          id: "prompt-plain",
          role: "user",
          text: "继续检查",
          createdAt: "2026-07-25T00:00:01.000Z",
        },
        {
          id: "assistant-plain",
          role: "assistant",
          text: "检查完成",
          createdAt: "2026-07-25T00:00:02.000Z",
        },
      ],
      [command],
    );

    expect(timeline).toEqual([
      { kind: "shared", message: command },
      {
        kind: "imported",
        item: {
          kind: "message",
          entry: {
            id: "assistant-plain",
            role: "assistant",
            text: "检查完成",
            createdAt: "2026-07-25T00:00:02.000Z",
          },
        },
      },
    ]);
  });

  it("deduplicates a plain attachment prompt by body and time", () => {
    const command = message(
      "prompt-attachment",
      "codex_prompt",
      "分析附件",
      "2026-07-25T00:00:00.000Z",
    );
    const timeline = buildUnifiedTimeline(
      [
        {
          id: "desktop-user-message",
          role: "user",
          text: "分析附件\n\nAttached file: notes.txt\ncontent",
          createdAt: "2026-07-25T00:00:01.000Z",
        },
      ],
      [command],
    );

    expect(timeline).toEqual([{ kind: "shared", message: command }]);
  });

  it("keeps an unrelated native Desktop message outside the matching time window", () => {
    const command = message(
      "prompt-1",
      "codex_prompt",
      "Continue",
      "2026-07-25T00:00:00.000Z",
    );
    const entry = {
      id: "native-user",
      role: "user" as const,
      text: "Continue",
      createdAt: "2026-07-25T00:03:00.001Z",
    };

    expect(buildUnifiedTimeline([entry], [command])).toContainEqual({
      kind: "imported",
      item: { kind: "message", entry },
    });
  });
});

describe("splitConversationMessages", () => {
  it("keeps member chat independent from the Codex timeline", () => {
    const chat = message("chat-1", "chat", "hello", "2026-07-25T00:00:00.000Z");
    const prompt = message(
      "prompt-1",
      "codex_prompt",
      "run checks",
      "2026-07-25T00:00:01.000Z",
    );
    const stop = message(
      "stop-1",
      "codex_stop",
      "stop",
      "2026-07-25T00:00:02.000Z",
    );

    expect(splitConversationMessages([chat, prompt, stop])).toEqual({
      chatMessages: [chat],
      codexMessages: [prompt, stop],
    });
  });
});

describe("executionDetailLabel", () => {
  it("summarizes execution record roles", () => {
    expect(
      executionDetailLabel([
        record("reasoning-1", "reasoning"),
        record("reasoning-2", "reasoning"),
        record("command-1", "command"),
      ]),
    ).toBe("2 条推理，1 条命令");
  });
});
