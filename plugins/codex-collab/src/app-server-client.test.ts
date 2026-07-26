import { describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAppServerClient,
  buildCodexTurnStartParams,
  decodeInlineTextAttachment,
  extractCodexRolloutActivity,
  extractCodexRecordEntries,
  extractCodexRolloutEntries,
  isCodexThreadBusy,
  readCodexThreadRevision,
} from "./app-server-client.js";

describe("Codex record import", () => {
  it("inlines bounded UTF-8 text attachments without shell access", () => {
    expect(
      decodeInlineTextAttachment({
        name: "notes.txt",
        mediaType: "text/plain",
        content: new TextEncoder().encode("ATTACHMENT_DIRECT_OK"),
      }),
    ).toBe("ATTACHMENT_DIRECT_OK");
    expect(
      decodeInlineTextAttachment({
        name: "archive.bin",
        mediaType: "application/octet-stream",
        content: new Uint8Array([0, 1, 2]),
      }),
    ).toBeNull();
  });

  it("maps the web composer settings to direct app-server turn parameters", () => {
    expect(
      buildCodexTurnStartParams({
        threadId: "thread-1",
        userInput: [
          { type: "text", text: "Run checks", text_elements: [] },
          {
            type: "localImage",
            path: "C:\\temp\\diagram.png",
            detail: "auto",
          },
          {
            type: "mention",
            name: "notes.txt",
            path: "C:\\temp\\notes.txt",
          },
        ],
        options: {
          accessMode: "full-access",
          customPermissions: null,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          speed: "fast",
          planMode: true,
        },
        currentModel: "gpt-5.4",
        currentReasoningEffort: "medium",
        peerDisplayName: "Owner",
        commandId: "prompt-1",
      }),
    ).toEqual({
      threadId: "thread-1",
      input: [
        { type: "text", text: "Run checks", text_elements: [] },
        {
          type: "localImage",
          path: "C:\\temp\\diagram.png",
          detail: "auto",
        },
        {
          type: "mention",
          name: "notes.txt",
          path: "C:\\temp\\notes.txt",
        },
      ],
      model: "gpt-5.6-sol",
      effort: "high",
      serviceTier: "priority",
      permissions: ":danger-full-access",
      approvalPolicy: "never",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.6-sol",
          reasoning_effort: "high",
          developer_instructions: null,
        },
      },
      responsesapiClientMetadata: {
        source: "codex-collab",
        collab_member: "Owner",
        collab_command_id: "prompt-1",
      },
    });
  });

  it("maps each custom file scope and approval policy exactly", () => {
    const profiles = [
      ["read-only", ":read-only"],
      ["workspace-write", ":workspace"],
      ["full-access", ":danger-full-access"],
    ] as const;
    for (const [fileAccess, permissions] of profiles) {
      expect(
        buildCodexTurnStartParams({
          threadId: "thread-custom",
          userInput: [{ type: "text", text: "Inspect", text_elements: [] }],
          options: {
            accessMode: "custom",
            customPermissions: { fileAccess, approvalPolicy: "on-request" },
            model: null,
            reasoningEffort: "follow-desktop",
            speed: "follow-desktop",
            planMode: false,
          },
          currentModel: "gpt-5.6-sol",
          currentReasoningEffort: "high",
          peerDisplayName: "Owner",
        }),
      ).toMatchObject({ permissions, approvalPolicy: "on-request" });
    }
    expect(() =>
      buildCodexTurnStartParams({
        threadId: "thread-custom",
        userInput: [{ type: "text", text: "Inspect", text_elements: [] }],
        options: {
          accessMode: "custom",
          customPermissions: null,
          model: null,
          reasoningEffort: "follow-desktop",
          speed: "follow-desktop",
          planMode: false,
        },
        currentModel: "gpt-5.6-sol",
        peerDisplayName: "Owner",
      }),
    ).toThrow(/missing/i);
  });

  it("blocks invalid capabilities after resolving the current task model", () => {
    const base = {
      threadId: "thread-capabilities",
      userInput: [{ type: "text" as const, text: "Run", text_elements: [] as [] }],
      peerDisplayName: "Owner",
    };
    expect(() =>
      buildCodexTurnStartParams({
        ...base,
        options: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: null,
          reasoningEffort: "follow-desktop",
          speed: "fast",
          planMode: false,
        },
        currentModel: "gpt-5.3-codex-spark",
      }),
    ).toThrow(/fast/i);
    expect(() =>
      buildCodexTurnStartParams({
        ...base,
        options: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: "gpt-5.6-luna",
          reasoningEffort: "ultra",
          speed: "standard",
          planMode: false,
        },
        currentModel: "gpt-5.6-sol",
      }),
    ).toThrow(/ultra/i);
    expect(() =>
      buildCodexTurnStartParams({
        ...base,
        attachmentMediaTypes: ["image/png"],
        options: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: null,
          reasoningEffort: "follow-desktop",
          speed: "standard",
          planMode: false,
        },
        currentModel: "gpt-5.3-codex-spark",
      }),
    ).toThrow(/image/i);
  });

  it("omits sticky overrides when the composer follows the selected task", () => {
    expect(
      buildCodexTurnStartParams({
        threadId: "thread-1",
        userInput: [{ type: "text", text: "Continue", text_elements: [] }],
        options: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: null,
          reasoningEffort: "follow-desktop",
          speed: "follow-desktop",
          planMode: false,
        },
        currentModel: "gpt-5.6-sol",
        currentReasoningEffort: "high",
        peerDisplayName: "Peer",
      }),
    ).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Continue", text_elements: [] }],
      responsesapiClientMetadata: {
        source: "codex-collab",
        collab_member: "Peer",
      },
    });
  });

  it("aligns the default collaboration mode with web model overrides", () => {
    expect(
      buildCodexTurnStartParams({
        threadId: "thread-1",
        userInput: [{ type: "text", text: "Which model?", text_elements: [] }],
        options: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: "gpt-5.6-luna",
          reasoningEffort: "low",
          speed: "follow-desktop",
          planMode: false,
        },
        currentModel: "gpt-5.6-sol",
        currentReasoningEffort: "xhigh",
        peerDisplayName: "Owner",
        commandId: "prompt-luna",
      }),
    ).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "low",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.6-luna",
          reasoning_effort: "low",
          developer_instructions: null,
        },
      },
    });
  });

  it("sends the resumed task settings and web overrides through Desktop IPC", async () => {
    const startTurn = vi.fn().mockResolvedValue({
      result: { turn: { id: "turn-luna" } },
    });
    const steerTurn = vi.fn();
    const client = new CodexAppServerClient({
      platform: "win32",
      desktopIpc: {
        startTurn,
        steerTurn,
        interruptTurn: vi.fn(),
        close: vi.fn(),
      },
    });
    Object.defineProperty(client, "start", {
      value: async () => undefined,
    });
    Object.defineProperty(client, "getActiveTurnId", {
      value: async () => null,
    });
    Object.defineProperty(client, "request", {
      value: async (method: string) => {
        if (method === "thread/resume") {
          return {
            thread: {},
            model: "gpt-5.6-sol",
            reasoningEffort: "xhigh",
          };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    });

    await expect(
      client.submitPeerPrompt({
        threadId: "thread-1",
        projectRoot: "E:\\Codex-Collab",
        commandId: "prompt-luna",
        peerDisplayName: "Owner",
        body: "Which model?",
        attachments: [],
        codexOptions: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: "gpt-5.6-luna",
          reasoningEffort: "low",
          speed: "follow-desktop",
          planMode: false,
        },
      }),
    ).resolves.toEqual({
      status: "submitted",
      mode: "started",
      turnId: "turn-luna",
    });
    expect(steerTurn).not.toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalledWith({
      conversationId: "thread-1",
      turnStartParams: {
        input: [{ type: "text", text: "Which model?", text_elements: [] }],
        model: "gpt-5.6-luna",
        effort: "low",
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.6-luna",
            reasoning_effort: "low",
            developer_instructions: null,
          },
        },
        responsesapiClientMetadata: {
          source: "codex-collab",
          collab_member: "Owner",
          collab_command_id: "prompt-luna",
        },
        clientUserMessageId: "prompt-luna",
        additionalContext: null,
      },
    });
  });

  it("keeps configured prompts queued while another turn is active", async () => {
    const startTurn = vi.fn();
    const steerTurn = vi.fn();
    const request = vi.fn();
    const client = new CodexAppServerClient({
      platform: "win32",
      desktopIpc: {
        startTurn,
        steerTurn,
        interruptTurn: vi.fn(),
        close: vi.fn(),
      },
    });
    Object.defineProperty(client, "start", {
      value: async () => undefined,
    });
    Object.defineProperty(client, "getActiveTurnId", {
      value: async () => "turn-active",
    });
    Object.defineProperty(client, "request", { value: request });

    await expect(
      client.submitPeerPrompt({
        threadId: "thread-1",
        projectRoot: "E:\\Codex-Collab",
        commandId: "prompt-queued",
        peerDisplayName: "Owner",
        body: "Run next",
        attachments: [],
        codexOptions: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: "gpt-5.6-luna",
          reasoningEffort: "low",
          speed: "follow-desktop",
          planMode: false,
        },
      }),
    ).resolves.toEqual({
      status: "deferred",
      reason: "active-turn",
      turnId: "turn-active",
    });
    expect(startTurn).not.toHaveBeenCalled();
    expect(steerTurn).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

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
  });

  it("detects changes to the selected task rollout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-revision-"));
    const path = join(directory, "rollout-thread-1.jsonl");
    try {
      await writeFile(path, "{}\n", "utf8");
      const first = await readCodexThreadRevision({
        id: "thread-1",
        updatedAt: 1,
        path,
      });
      await appendFile(path, "{}\n", "utf8");
      const second = await readCodexThreadRevision({
        id: "thread-1",
        updatedAt: 1,
        path,
      });

      expect(first).not.toBeNull();
      expect(second).not.toBe(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back to app-server history and status for oversized rollouts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-large-rollout-"));
    const path = join(directory, "rollout-thread-1.jsonl");
    const client = new CodexAppServerClient();
    const requestMethods: string[] = [];
    Object.defineProperty(client, "start", {
      value: async () => undefined,
    });
    Object.defineProperty(client, "request", {
      value: async (method: string, parameters: Record<string, unknown>) => {
        requestMethods.push(method);
        if (method === "thread/resume") return {};
        if (method === "thread/turns/list") {
          return {
            data: [
              {
                id: "turn-1",
                status:
                  parameters.itemsView === "summary" ? "inProgress" : "completed",
                items:
                  parameters.itemsView === "summary"
                    ? []
                    : [{ type: "agentMessage", id: "agent-1", text: "Latest response" }],
              },
            ],
            nextCursor: null,
          };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    });

    try {
      await writeFile(path, "{}\n", "utf8");
      await truncate(path, 20_000_001);

      await expect(client.readThreadHistory("thread-1", path)).resolves.toEqual([
        {
          id: "agent-1",
          role: "assistant",
          text: "Latest response",
          createdAt: null,
        },
      ]);
      await expect(client.isThreadBusyForPrompt("thread-1", path)).resolves.toBe(true);
      expect(requestMethods).toEqual([
        "thread/turns/list",
        "thread/resume",
        "thread/turns/list",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves recent commands from the tail of an oversized rollout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-large-history-"));
    const path = join(directory, "rollout-thread-1.jsonl");
    const client = new CodexAppServerClient();
    const request = vi.fn(async (method: string) => {
      throw new Error(`App-server fallback should not run: ${method}`);
    });
    Object.defineProperty(client, "start", { value: async () => undefined });
    Object.defineProperty(client, "request", { value: request });

    try {
      await writeFile(path, "{}\n", "utf8");
      await truncate(path, 20_000_001);
      await appendFile(
        path,
        [
          "",
          JSON.stringify({
            timestamp: "2026-07-25T00:00:02.000Z",
            type: "response_item",
            payload: {
              type: "function_call",
              id: "large-command",
              call_id: "large-call",
              name: "exec_command",
              arguments: JSON.stringify({ cmd: "npm test" }),
            },
          }),
          JSON.stringify({
            timestamp: "2026-07-25T00:00:03.000Z",
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "large-call",
              output: "257 command records preserved",
            },
          }),
          "",
        ].join("\n"),
        "utf8",
      );

      const records = await client.readThreadHistory("thread-1", path);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ id: "large-command", role: "command" });
      expect(records[0]?.text).toContain("npm test");
      expect(records[0]?.text).toContain("257 command records preserved");
      expect(request).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("detects an active task from an oversized rollout when app-server has no turns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-large-activity-"));
    const path = join(directory, "rollout-thread-1.jsonl");
    const client = new CodexAppServerClient();
    Object.defineProperty(client, "start", {
      value: async () => undefined,
    });
    Object.defineProperty(client, "request", {
      value: async (method: string) => {
        if (method === "thread/resume") return {};
        if (method === "thread/turns/list") return { data: [] };
        throw new Error(`Unexpected request: ${method}`);
      },
    });

    try {
      await writeFile(path, "{}\n", "utf8");
      await truncate(path, 20_000_001);
      await appendFile(
        path,
        `\n${JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-large",
          },
        })}\n`,
        "utf8",
      );

      await expect(
        client.isThreadBusyForPrompt("thread-1", path),
      ).resolves.toBe(true);
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("detects an active turn from app-server status", () => {
    expect(
      isCodexThreadBusy(
        {
          openTurnIds: [],
          latestObservedTurnId: null,
          latestObservedAtMs: null,
        },
        [{ id: "turn-1", status: "inProgress" }],
      ),
    ).toBe(true);
  });

  it("keeps a recently writing rollout busy when its persisted turn is terminal", () => {
    const activity = extractCodexRolloutActivity([
      JSON.stringify({
        timestamp: "2026-07-25T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      }),
      JSON.stringify({
        timestamp: "2026-07-25T00:01:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      }),
    ]);

    expect(
      isCodexThreadBusy(
        activity,
        [{ id: "turn-1", status: "interrupted" }],
        Date.parse("2026-07-25T00:01:30.000Z"),
      ),
    ).toBe(true);
    expect(
      isCodexThreadBusy(
        activity,
        [{ id: "turn-1", status: "interrupted" }],
        Date.parse("2026-07-25T00:04:00.000Z"),
      ),
    ).toBe(false);
  });

  it("unblocks when the rollout closes its active turn", () => {
    const activity = extractCodexRolloutActivity([
      JSON.stringify({
        timestamp: "2026-07-25T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      }),
      JSON.stringify({
        timestamp: "2026-07-25T00:01:00.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1" },
      }),
    ]);

    expect(isCodexThreadBusy(activity, [])).toBe(false);
  });

  it("merges appended rollout activity without losing open turns", () => {
    const started = extractCodexRolloutActivity([
      JSON.stringify({
        timestamp: "2026-07-25T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      }),
    ]);
    const completed = extractCodexRolloutActivity(
      [
        JSON.stringify({
          timestamp: "2026-07-25T00:01:00.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        }),
      ],
      started,
    );

    expect(started.openTurnIds).toEqual(["turn-1"]);
    expect(completed.openTurnIds).toEqual([]);
    expect(completed.latestObservedTurnId).toBe("turn-1");
  });

  it("uses the turn id interrupted by Desktop IPC without a local active-turn lookup", async () => {
    const interruptCalls: Array<Record<string, unknown>> = [];
    const client = new CodexAppServerClient({
      platform: "win32",
      desktopIpc: {
        startTurn: async () => null,
        steerTurn: async () => null,
        interruptTurn: async (input) => {
          interruptCalls.push(input);
          return { ok: true, interruptedTurnId: "turn-desktop" };
        },
        close: async () => undefined,
      },
    });
    Object.defineProperty(client, "start", {
      value: async () => undefined,
    });
    Object.defineProperty(client, "request", {
      value: async () => {
        throw new Error("The local app-server should not be queried");
      },
    });

    await expect(
      client.stopPeerPrompt({ threadId: "thread-1" }),
    ).resolves.toEqual({
      status: "submitted",
      mode: "interrupted",
      turnId: "turn-desktop",
    });
    expect(interruptCalls).toEqual([
      { conversationId: "thread-1", mode: "user-stop" },
    ]);
  });

  it("falls back to app-server turn/interrupt and confirms the terminal state", async () => {
    const requests: Array<{
      method: string;
      parameters: Record<string, unknown>;
    }> = [];
    let turnListCount = 0;
    const client = new CodexAppServerClient({
      platform: "win32",
      desktopIpc: {
        startTurn: async () => null,
        steerTurn: async () => null,
        interruptTurn: async () => {
          throw new Error("Desktop owner unavailable");
        },
        close: async () => undefined,
      },
    });
    Object.defineProperty(client, "start", {
      value: async () => undefined,
    });
    Object.defineProperty(client, "request", {
      value: async (
        method: string,
        parameters: Record<string, unknown>,
      ) => {
        requests.push({ method, parameters });
        if (method === "thread/resume" || method === "turn/interrupt") {
          return {};
        }
        if (method === "thread/turns/list") {
          turnListCount += 1;
          return {
            data: [
              {
                id: "turn-fallback",
                status: turnListCount === 1 ? "inProgress" : "interrupted",
              },
            ],
          };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    });

    await expect(
      client.stopPeerPrompt({ threadId: "thread-1" }),
    ).resolves.toEqual({
      status: "submitted",
      mode: "interrupted",
      turnId: "turn-fallback",
    });
    expect(requests.map((request) => request.method)).toEqual([
      "thread/turns/list",
      "thread/resume",
      "turn/interrupt",
      "thread/turns/list",
    ]);
    expect(requests[2]?.parameters).toEqual({
      threadId: "thread-1",
      turnId: "turn-fallback",
    });
  });
});
