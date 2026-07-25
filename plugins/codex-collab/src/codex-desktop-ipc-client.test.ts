import { createServer, Socket, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexDesktopIpcClient,
  DesktopIpcFrameDecoder,
  encodeDesktopIpcFrame,
} from "./codex-desktop-ipc-client.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("Codex Desktop IPC client", () => {
  it("decodes partial and combined length-prefixed JSON frames", () => {
    const decoder = new DesktopIpcFrameDecoder();
    const first = encodeDesktopIpcFrame({ id: 1, text: "你好" });
    const second = encodeDesktopIpcFrame({ id: 2 });

    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(
      decoder.push(Buffer.concat([first.subarray(3), second])),
    ).toEqual([
      { id: 1, text: "你好" },
      { id: 2 },
    ]);
  });

  it("initializes and forwards a start-turn request with protocol version 1", async () => {
    const received: Array<Record<string, unknown>> = [];
    const decoder = new DesktopIpcFrameDecoder();
    const server = createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
          const request = message as Record<string, unknown>;
          received.push(request);
          if (request.method === "initialize") {
            socket.write(
              encodeDesktopIpcFrame({
                type: "response",
                requestId: request.requestId,
                resultType: "success",
                method: "initialize",
                result: { clientId: "client-1" },
              }),
            );
          } else {
            socket.write(
              encodeDesktopIpcFrame({
                type: "response",
                requestId: request.requestId,
                resultType: "success",
                method: request.method,
                result: { result: { turn: { id: "turn-1" } } },
              }),
            );
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");

    const client = new CodexDesktopIpcClient({
      socketFactory: () => {
        const socket = new Socket();
        socket.connect(address.port, "127.0.0.1");
        return socket;
      },
    });
    await expect(
      client.startTurn({
        conversationId: "thread-1",
        turnStartParams: {
          input: [{ type: "text", text: "Continue", text_elements: [] }],
        },
      }),
    ).resolves.toEqual({ result: { turn: { id: "turn-1" } } });
    await client.close();

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      sourceClientId: "initializing-client",
      version: 0,
      method: "initialize",
      params: { clientType: "CODEX_COLLAB_HOST" },
    });
    expect(received[1]).toMatchObject({
      sourceClientId: "client-1",
      version: 1,
      method: "thread-follower-start-turn",
      params: {
        conversationId: "thread-1",
      },
    });
  });

  it("surfaces the missing desktop owner instead of reporting submission", async () => {
    const decoder = new DesktopIpcFrameDecoder();
    const server = createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
          const request = message as Record<string, unknown>;
          socket.write(
            encodeDesktopIpcFrame(
              request.method === "initialize"
                ? {
                    type: "response",
                    requestId: request.requestId,
                    resultType: "success",
                    method: "initialize",
                    result: { clientId: "client-1" },
                  }
                : {
                    type: "response",
                    requestId: request.requestId,
                    resultType: "error",
                    error: "no-client-found",
                  },
            ),
          );
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const client = new CodexDesktopIpcClient({
      socketFactory: () => {
        const socket = new Socket();
        socket.connect(address.port, "127.0.0.1");
        return socket;
      },
    });

    await expect(
      client.startTurn({
        conversationId: "thread-1",
        turnStartParams: { input: [] },
      }),
    ).rejects.toThrow("not currently owning");
    await client.close();
  });

  it("returns the turn id actually interrupted by the desktop owner", async () => {
    const received: Array<Record<string, unknown>> = [];
    const decoder = new DesktopIpcFrameDecoder();
    const server = createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
          const request = message as Record<string, unknown>;
          received.push(request);
          socket.write(
            encodeDesktopIpcFrame({
              type: "response",
              requestId: request.requestId,
              resultType: "success",
              method: request.method,
              result:
                request.method === "initialize"
                  ? { clientId: "client-1" }
                  : { ok: true, interruptedTurnId: "turn-active" },
            }),
          );
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const client = new CodexDesktopIpcClient({
      socketFactory: () => {
        const socket = new Socket();
        socket.connect(address.port, "127.0.0.1");
        return socket;
      },
    });

    await expect(
      client.interruptTurn({
        conversationId: "thread-1",
        mode: "user-stop",
      }),
    ).resolves.toEqual({
      ok: true,
      interruptedTurnId: "turn-active",
    });
    await client.close();

    expect(received[1]).toMatchObject({
      sourceClientId: "client-1",
      version: 3,
      method: "thread-follower-interrupt-turn",
      params: {
        conversationId: "thread-1",
        mode: "user-stop",
      },
    });
  });

  it("rejects a success response that does not identify the interrupted turn", async () => {
    const decoder = new DesktopIpcFrameDecoder();
    const server = createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
          const request = message as Record<string, unknown>;
          socket.write(
            encodeDesktopIpcFrame({
              type: "response",
              requestId: request.requestId,
              resultType: "success",
              method: request.method,
              result:
                request.method === "initialize"
                  ? { clientId: "client-1" }
                  : { ok: true },
            }),
          );
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const client = new CodexDesktopIpcClient({
      socketFactory: () => {
        const socket = new Socket();
        socket.connect(address.port, "127.0.0.1");
        return socket;
      },
    });

    await expect(
      client.interruptTurn({
        conversationId: "thread-1",
        mode: "user-stop",
      }),
    ).rejects.toThrow("invalid interrupt result");
    await client.close();
  });
});
