import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { HostIpcServerAuthenticator, type HostIpcCapability } from "./authentication.js";
import { encodeHostIpcFrame, HostIpcFrameDecoder } from "./framing.js";
import {
  type AuthenticatedHostIpcPeer,
  type HostIpcRequestV1,
  type HostIpcResponseV1,
  parseHostIpcRequest,
} from "./protocol.js";
import { connectHostIpcClient } from "./transport.js";

const pipePath = String.raw`\\.\pipe\codex-collab-host-0123456789abcdef0123456789abcdef`;

describe("Host IPC named-pipe client transport", () => {
  it("performs the mutual HMAC handshake before exposing status", async () => {
    const capability = testCapability("mcp");
    const streams = duplexPair();
    const requests: HostIpcRequestV1[] = [];
    serve(streams.server, capability, async (request) => {
      requests.push(request);
      return {
        phase: "active",
        paired: true,
        acceptingWork: true,
        since: "2026-07-28T00:00:00.000Z",
      };
    });
    const connectStream = vi.fn(async () => streams.client);

    const client = await connectHostIpcClient({ pipePath, capability, connectStream });

    await expect(client.status()).resolves.toMatchObject({ phase: "active", paired: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("host.status");
    expect(connectStream).toHaveBeenCalledWith(pipePath);
    expect("request" in client).toBe(false);
    client.close();
  });

  it("routes concurrent responses by id even when they arrive out of order", async () => {
    const capability = testCapability("mcp");
    const streams = duplexPair();
    const replies: Array<(value: unknown) => void> = [];
    serve(
      streams.server,
      capability,
      () =>
        new Promise((resolve) => {
          replies.push(resolve);
        }),
    );
    const client = await connectHostIpcClient({
      pipePath,
      capability,
      connectStream: async () => streams.client,
    });

    const first = client.callTool("collab_health", { sequence: 1 });
    const second = client.callTool("collab_health", { sequence: 2 });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[1]?.("second");
    replies[0]?.("first");

    await expect(second).resolves.toBe("second");
    await expect(first).resolves.toBe("first");
    client.close();
  });

  it("gives desktop clients graceful stop without exposing MCP calls", async () => {
    const capability = testCapability("desktop");
    const streams = duplexPair();
    const methods: string[] = [];
    serve(streams.server, capability, async (request) => {
      methods.push(request.method);
      return request.method === "host.gracefulStop"
        ? { stopping: true }
        : {
            phase: "suspended",
            paired: true,
            acceptingWork: false,
            since: "2026-07-28T00:00:00.000Z",
          };
    });
    const client = await connectHostIpcClient({
      pipePath,
      capability,
      connectStream: async () => streams.client,
    });

    await expect(client.gracefulStop()).resolves.toBeUndefined();
    expect(methods).toEqual(["host.gracefulStop"]);
    expect("callTool" in client).toBe(false);
    expect("request" in client).toBe(false);
    client.close();
  });

  it("rejects every pending request when the pipe disconnects", async () => {
    const capability = testCapability("mcp");
    const streams = duplexPair();
    const requests: HostIpcRequestV1[] = [];
    serve(
      streams.server,
      capability,
      (request) => {
        requests.push(request);
        return new Promise(() => undefined);
      },
    );
    const client = await connectHostIpcClient({
      pipePath,
      capability,
      connectStream: async () => streams.client,
    });

    const first = client.callTool("collab_health", {});
    const second = client.callTool("collab_status", {});
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    streams.server.destroy();

    await expect(first).rejects.toThrow(/connection (ended|closed)/i);
    await expect(second).rejects.toThrow(/connection (ended|closed)/i);
  });
});

function testCapability(
  clientKind: "mcp",
): HostIpcCapability & { clientKind: "mcp" };
function testCapability(
  clientKind: "desktop",
): HostIpcCapability & { clientKind: "desktop" };
function testCapability(clientKind: "mcp" | "desktop"): HostIpcCapability {
  return {
    clientKind,
    keyId: `${clientKind}-test`,
    secret: Buffer.alloc(32, clientKind === "mcp" ? 1 : 2),
  };
}

function serve(
  stream: Duplex,
  capability: HostIpcCapability,
  handle: (request: HostIpcRequestV1, peer: AuthenticatedHostIpcPeer) => Promise<unknown>,
): void {
  const decoder = new HostIpcFrameDecoder();
  const authenticator = new HostIpcServerAuthenticator((keyId) =>
    keyId === capability.keyId ? capability : undefined,
  );
  let peer: AuthenticatedHostIpcPeer | undefined;
  let state: "hello" | "proof" | "authenticated" = "hello";

  stream.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (state === "hello") {
        stream.write(encodeHostIpcFrame(authenticator.begin("test-connection", frame), false));
        state = "proof";
        continue;
      }
      if (state === "proof") {
        const authenticated = authenticator.complete("test-connection", frame);
        peer = authenticated.peer;
        state = "authenticated";
        decoder.setAuthenticated();
        stream.write(encodeHostIpcFrame(authenticated.ready, false));
        continue;
      }
      const request = parseHostIpcRequest(frame);
      void handle(request, peer!).then(
        (result) => writeResponse(stream, { v: 1, type: "response", id: request.id, ok: true, result }),
        (error: unknown) =>
          writeResponse(stream, {
            v: 1,
            type: "response",
            id: request.id,
            ok: false,
            error: { code: "host_error", message: String(error) },
          }),
      );
    }
  });
}

function writeResponse(stream: Duplex, response: HostIpcResponseV1): void {
  stream.write(encodeHostIpcFrame(response, true));
}

function duplexPair(): { client: Duplex; server: Duplex } {
  const client = new MemoryDuplex();
  const server = new MemoryDuplex();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

class MemoryDuplex extends Duplex {
  peer: MemoryDuplex | undefined;

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.peer || this.peer.destroyed) {
      callback(new Error("peer is closed"));
      return;
    }
    this.peer.push(Buffer.from(chunk));
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.peer && !this.peer.destroyed) this.peer.push(null);
    callback(error);
  }
}
