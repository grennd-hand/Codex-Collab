import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  extractCodexRolloutActivity,
  isCodexThreadBusy,
  readCodexThreadRevision,
} from "./app-server-client.js";

describe("Codex rollout activity", () => {
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

  it("ignores a stale app-server inProgress status after the rollout closed the turn", () => {
    expect(
      isCodexThreadBusy(
        {
          openTurnIds: [],
          latestObservedTurnId: "turn-2",
          latestObservedAtMs: Date.parse("2026-07-25T00:02:00.000Z"),
        },
        [
          { id: "turn-2", status: "completed" },
          { id: "turn-1", status: "inProgress" },
        ],
      ),
    ).toBe(false);
  });

  it("keeps a newer app-server turn busy before its rollout start is persisted", () => {
    expect(
      isCodexThreadBusy(
        {
          openTurnIds: [],
          latestObservedTurnId: "turn-1",
          latestObservedAtMs: Date.parse("2026-07-25T00:02:00.000Z"),
        },
        [
          { id: "turn-2", status: "inProgress" },
          { id: "turn-1", status: "completed" },
        ],
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

});
