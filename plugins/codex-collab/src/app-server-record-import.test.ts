import { join } from "node:path";
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
    expect(records[2]?.text).toContain("status: completed");
    expect(records[2]?.text).toContain("AUTH_TOKEN=[REDACTED]");
    expect(records.some((record) => record.text.includes("private raw"))).toBe(false);
    expect(records.some((record) => record.text.includes("abcdefghijklmnopqrstuvwxyz"))).toBe(
      false,
    );
  });

  it("marks app-server command records as running before an exit code exists", () => {
    const records = extractCodexRecordEntries([
      {
        id: "turn-running",
        status: "inProgress",
        items: [
          {
            type: "commandExecution",
            id: "command-running",
            command: "npm run build",
            cwd: "E:/Project",
            aggregatedOutput: "building...",
            exitCode: null,
            durationMs: null,
          },
        ],
      },
    ]);

    expect(records[0]?.text).toContain("status: running");
    expect(records[0]?.text).toContain("building...");
  });

  it("preserves app-server commentary and final-answer phases", () => {
    const records = extractCodexRecordEntries([
      {
        id: "turn-phases",
        items: [
          {
            type: "agentMessage",
            id: "assistant-progress",
            phase: "commentary",
            text: "正在检查。",
          },
          {
            type: "agentMessage",
            id: "assistant-final",
            phase: "final_answer",
            text: "检查完成。",
          },
        ],
      },
    ]);

    expect(records.map((record) => record.phase)).toEqual(["commentary", "final_answer"]);
  });

  it("imports app-server file changes without exposing patch contents", () => {
    const records = extractCodexRecordEntries([
      {
        id: "turn-file-change",
        status: "completed",
        items: [
          { type: "reasoning", id: "reasoning-before", summary: ["Preparing the edit"] },
          {
            type: "fileChange",
            id: "file-change-1",
            status: "completed",
            changes: [
              {
                path: "E:\\Project\\config.ts",
                kind: { type: "update", move_path: null },
                diff: "-PASSWORD=old-secret-value\n+PASSWORD=new-secret-value",
              },
            ],
          },
          { type: "reasoning", id: "reasoning-after", summary: ["Checking the edit"] },
        ],
      },
    ]);

    expect(records.map((record) => record.role)).toEqual([
      "reasoning",
      "command",
      "reasoning",
    ]);
    expect(records[1]?.text).toContain("tool: apply_patch");
    expect(records[1]?.text).toContain("修改 E:\\Project\\config.ts（+1 -1）");
    expect(records[1]?.text).not.toContain("old-secret-value");
    expect(records[1]?.text).not.toContain("new-secret-value");
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

  it("includes unfinished tool calls as live running steps", () => {
    const records = extractCodexRolloutEntries(
      [
        JSON.stringify({
          timestamp: "2026-07-25T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "call-item-running",
            call_id: "call-running",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "npm run build" }),
          },
        }),
      ],
      "thread-1",
    );

    expect(records).toEqual([
      {
        id: "call-item-running",
        role: "command",
        text: [
          "tool: exec_command",
          "status: running",
          "input:",
          '{"cmd":"npm run build"}',
        ].join("\n"),
        createdAt: "2026-07-25T00:00:02.000Z",
      },
    ]);
  });

  it("preserves rollout commentary and final-answer phases", () => {
    const records = extractCodexRolloutEntries(
      ["commentary", "final_answer"].map((phase, index) =>
        JSON.stringify({
          timestamp: `2026-07-25T00:00:0${index}.000Z`,
          type: "response_item",
          payload: {
            type: "message",
            id: `assistant-${index}`,
            role: "assistant",
            phase,
            content: [{ type: "output_text", text: phase }],
          },
        }),
      ),
      "thread-1",
    );

    expect(records.map((record) => record.phase)).toEqual(["commentary", "final_answer"]);
  });

  it("removes Desktop attachment wrappers before publishing user history", () => {
    const wrapped = [
      "# Files mentioned by the user:",
      "",
      "## screenshot.png: C:/Users/test/AppData/Local/Temp/screenshot.png",
      "",
      "## My request for Codex:",
      "只保留这句正文。",
      "",
      '<image name=[Image #1] path="C:\\Users\\test\\Temp\\screenshot.png">',
      "</image>",
    ].join("\n");
    const records = extractCodexRolloutEntries(
      [
        JSON.stringify({
          timestamp: "2026-07-25T00:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "user-with-image",
            role: "user",
            content: [{ type: "input_text", text: wrapped }],
          },
        }),
      ],
      "thread-1",
    );

    expect(records[0]?.text).toBe("只保留这句正文。");
  });

  it("removes Codex rendering metadata before publishing final answers", () => {
    const finalAnswer = [
      "部署完成。",
      "",
      '::git-push{cwd="E:/Codex-Collab" branch="main"}',
      "",
      "<oai-mem-citation>",
      "<citation_entries>",
      "MEMORY.md:109-111|note=[deployment boundary]",
      "</citation_entries>",
      "<rollout_ids>",
      "019f94f6-7582-7a20-8538-befd4fd7413c",
      "</rollout_ids>",
      "</oai-mem-citation>",
    ].join("\n");
    const records = extractCodexRolloutEntries(
      [
        JSON.stringify({
          timestamp: "2026-07-25T00:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "assistant-final",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: finalAnswer }],
          },
        }),
      ],
      "thread-1",
    );

    expect(records[0]?.text).toBe("部署完成。");
  });

  it("hides unfinished apply_patch contents while keeping the edited filename", () => {
    const records = extractCodexRolloutEntries(
      [
        JSON.stringify({
          timestamp: "2026-07-25T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            call_id: "patch-running",
            name: "apply_patch",
            input: "*** Begin Patch\n*** Update File: E:\\Project\\config.ts\n+PASSWORD=unredacted-secret-value",
          },
        }),
      ],
      "thread-1",
    );

    expect(records[0]?.text).toContain("修改 E:\\Project\\config.ts");
    expect(records[0]?.text).not.toContain("unredacted-secret-value");
    expect(records[0]?.fileChanges).toEqual([
      expect.objectContaining({
        operationId: "patch-running:1",
        taskId: "thread-1",
        path: "E:/Project/config.ts",
        kind: "modified",
        lifecycle: "running",
      }),
    ]);
  });

  it("uses a safe patch summary without duplicating the apply_patch call", () => {
    const records = extractCodexRolloutEntries(
      [
        JSON.stringify({
          timestamp: "2026-07-25T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            call_id: "patch-call-1",
            name: "apply_patch",
            input: "*** Begin Patch\n-PASSWORD=old-secret-value\n+PASSWORD=new-secret-value",
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-25T00:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "patch_apply_end",
            call_id: "patch-call-1",
            success: true,
            status: "completed",
            changes: {
              "E:\\Project\\config.ts": {
                type: "update",
                unified_diff: "-PASSWORD=old-secret-value\n+PASSWORD=new-secret-value",
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-25T00:00:04.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "patch-call-1",
            output: "Done!",
          },
        }),
      ],
      "thread-1",
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.role).toBe("command");
    expect(records[0]?.text).toContain("修改 E:\\Project\\config.ts（+1 -1）");
    expect(records[0]?.text).toContain("Done!");
    expect(records[0]?.text).not.toContain("old-secret-value");
    expect(records[0]?.text).not.toContain("new-secret-value");
    expect(records[0]?.fileChanges).toEqual([
      expect.objectContaining({
        operationId: "patch-call-1:0",
        taskId: "thread-1",
        path: "E:/Project/config.ts",
        kind: "modified",
        lifecycle: "completed",
        additions: 1,
        deletions: 1,
      }),
    ]);
  });

});
