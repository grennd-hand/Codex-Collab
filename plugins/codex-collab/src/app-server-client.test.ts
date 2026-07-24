import { describe, expect, it } from "vitest";
import {
  extractCodexRecordEntries,
  extractCodexRolloutEntries,
} from "./app-server-client.js";

describe("Codex record import", () => {
  it("imports visible messages, reasoning summaries and redacted command output", () => {
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
          {
            type: "reasoning",
            id: "reasoning-1",
            summary: ["Checked the dependency graph"],
            content: ["private raw chain of thought"],
          },
          {
            type: "commandExecution",
            id: "command-1",
            command: "npm test",
            cwd: "E:/Project",
            aggregatedOutput: "AUTH_TOKEN=abcdefghijklmnopqrstuvwxyz123456",
            exitCode: 0,
            durationMs: 1200,
          },
          { type: "agentMessage", id: "agent-1", text: "All tests passed." },
        ],
      },
    ]);

    expect(records).toHaveLength(4);
    expect(records.map((record) => record.role)).toEqual([
      "user",
      "reasoning",
      "command",
      "assistant",
    ]);
    expect(records[1]?.text).toBe("Checked the dependency graph");
    expect(records[2]?.text).toContain("$ npm test");
    expect(records[2]?.text).toContain("AUTH_TOKEN=[REDACTED]");
    expect(records.some((record) => record.text.includes("private raw"))).toBe(false);
    expect(records.some((record) => record.text.includes("abcdefghijklmnopqrstuvwxyz"))).toBe(
      false,
    );
  });

  it("recovers selected-task command output from its rollout without raw reasoning", () => {
    const lines = [
      JSON.stringify({
        timestamp: "2026-07-25T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "user-1",
          role: "user",
          content: [{ type: "input_text", text: "Run the tests" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-25T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          id: "reasoning-1",
          summary: [{ type: "summary_text", text: "Checking the suite" }],
          encrypted_content: "not-for-sharing",
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-25T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          id: "call-item-1",
          call_id: "call-1",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "npm test" }),
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-25T00:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "21 tests passed\nAPI_KEY=abcdefghijklmnopqrstuvwxyz123456",
        },
      }),
    ];

    const records = extractCodexRolloutEntries(lines, "thread-1");
    expect(records.map((record) => record.role)).toEqual([
      "user",
      "reasoning",
      "command",
    ]);
    expect(records[1]?.text).toBe("Checking the suite");
    expect(records[2]?.text).toContain("npm test");
    expect(records[2]?.text).toContain("21 tests passed");
    expect(records[2]?.text).toContain("API_KEY=[REDACTED]");
    expect(records.some((record) => record.text.includes("not-for-sharing"))).toBe(false);
  });
});
