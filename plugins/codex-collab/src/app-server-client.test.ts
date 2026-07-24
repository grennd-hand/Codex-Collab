import { describe, expect, it } from "vitest";
import { extractCodexRecordEntries } from "./app-server-client.js";

describe("Codex record import", () => {
  it("imports only visible user and assistant messages", () => {
    const records = extractCodexRecordEntries([
      {
        id: "turn-1",
        startedAt: 1_753_401_600,
        items: [
          {
            type: "userMessage",
            id: "user-1",
            content: [
              { type: "text", text: "Please run tests" },
              { type: "localImage" },
            ],
          },
          { type: "reasoning", id: "reasoning-1", text: "private chain of thought" },
          { type: "commandExecution", id: "command-1", text: "secret output" },
          { type: "agentMessage", id: "agent-1", text: "All tests passed." },
        ],
      },
    ]);

    expect(records).toHaveLength(2);
    expect(records.map((record) => record.role)).toEqual(["user", "assistant"]);
    expect(records.map((record) => record.text)).toEqual([
      "Please run tests",
      "All tests passed.",
    ]);
    expect(records.some((record) => record.text.includes("private"))).toBe(false);
  });
});
