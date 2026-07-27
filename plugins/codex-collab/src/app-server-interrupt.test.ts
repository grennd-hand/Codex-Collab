import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "./app-server-client.js";

describe("Codex app-server interruption", () => {
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
