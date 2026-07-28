import { describe, expect, it, vi } from "vitest";
import { collabTools } from "../../mcp-tool-catalog.js";
import type { HostApplication } from "../host-application.js";
import {
  HostIpcClientAuthenticator,
  HostIpcServerAuthenticator,
  type HostIpcCapability,
} from "./authentication.js";
import { HostIpcClientProtocol } from "./client.js";
import { HostIpcRequestDispatcher } from "./dispatcher.js";
import { encodeHostIpcFrame, HostIpcFrameDecoder } from "./framing.js";
import {
  HOST_IPC_AUTHENTICATED_FRAME_LIMIT,
  HOST_IPC_PROTOCOL_VERSION,
  HOST_IPC_UNAUTHENTICATED_FRAME_LIMIT,
  HOST_TOOL_METHODS,
  type AuthenticatedHostIpcPeer,
  type HostIpcMethod,
  HostIpcProtocolError,
  type HostIpcRequestV1,
  parseHostIpcRequest,
  parseHostIpcResponse,
} from "./protocol.js";

const capability: HostIpcCapability = {
  keyId: "desktop-main",
  clientKind: "desktop",
  secret: Buffer.alloc(32, 0xa5),
};

function sequenceRandom(...bytes: number[]) {
  let index = 0;
  return (size: number) => Buffer.alloc(size, bytes[index++] ?? 0xff);
}

function peer(clientKind: "mcp" | "desktop" = "desktop"): AuthenticatedHostIpcPeer {
  return {
    clientKind,
    keyId: `${clientKind}-main`,
    sessionId: "session-1",
    authenticatedAt: 1_000,
  };
}

function request(
  method: HostIpcMethod,
  overrides: Partial<HostIpcRequestV1> = {},
): HostIpcRequestV1 {
  return {
    v: HOST_IPC_PROTOCOL_VERSION,
    type: "request",
    id: "request-1",
    method,
    params: {},
    sentAt: 1_000,
    timeoutMs: 30_000,
    ...overrides,
  };
}

describe("Host IPC protocol", () => {
  it("keeps the IPC tool allowlist identical to the 18 MCP tools", () => {
    expect(HOST_TOOL_METHODS).toHaveLength(18);
    expect([...HOST_TOOL_METHODS]).toEqual(collabTools.map((tool) => tool.name));
  });

  it("rejects generic shell, URL, path and callTool RPC methods", () => {
    for (const method of ["callTool", "shell.exec", "url.fetch", "path.read", "C:\\secret"]) {
      expect(() => parseHostIpcRequest({ ...request("host.status"), method })).toThrowError(
        expect.objectContaining({ code: "method_not_allowed" }),
      );
    }
  });

  it("requires versioned, strict request frames", () => {
    expect(() => parseHostIpcRequest({ ...request("host.status"), v: 2 })).toThrow(
      "Unsupported IPC protocol version",
    );
    expect(() =>
      parseHostIpcRequest({ ...request("host.status"), arbitrary: "field" }),
    ).toThrow("unsupported fields");
  });

  it("strictly validates versioned responses and error codes", () => {
    expect(
      parseHostIpcResponse({ v: 1, type: "response", id: "request-1", ok: true, result: {} }),
    ).toMatchObject({ ok: true });
    expect(() =>
      parseHostIpcResponse({
        v: 1,
        type: "response",
        id: "request-1",
        ok: false,
        error: { code: "shell_failed", message: "no" },
      }),
    ).toThrow("error code is invalid");
  });
});

describe("Host IPC framing", () => {
  it("uses 4-byte little-endian framing and accepts fragmented input", () => {
    const encoded = encodeHostIpcFrame(request("host.status"), false);
    expect(encoded.readUInt32LE(0)).toBe(encoded.byteLength - 4);
    const decoder = new HostIpcFrameDecoder();
    expect(decoder.push(encoded.subarray(0, 7))).toEqual([]);
    expect(decoder.push(encoded.subarray(7))).toEqual([request("host.status")]);
    const byteDecoder = new HostIpcFrameDecoder();
    const decoded = [...encoded].flatMap((byte) => byteDecoder.push(Uint8Array.of(byte)));
    expect(decoded).toEqual([request("host.status")]);
  });

  it("enforces 8 KiB before auth and 16 MiB after auth", () => {
    const large = { v: 1, value: "x".repeat(HOST_IPC_UNAUTHENTICATED_FRAME_LIMIT) };
    expect(() => encodeHostIpcFrame(large, false)).toThrow("8192 byte limit");
    expect(() => encodeHostIpcFrame(large, true)).not.toThrow();

    const decoder = new HostIpcFrameDecoder();
    const unauthenticatedHeader = Buffer.alloc(4);
    unauthenticatedHeader.writeUInt32LE(HOST_IPC_UNAUTHENTICATED_FRAME_LIMIT + 1);
    expect(() => decoder.push(unauthenticatedHeader)).toThrow("8192 byte limit");

    const authenticatedDecoder = new HostIpcFrameDecoder();
    authenticatedDecoder.setAuthenticated();
    const authenticatedHeader = Buffer.alloc(4);
    authenticatedHeader.writeUInt32LE(HOST_IPC_AUTHENTICATED_FRAME_LIMIT + 1);
    expect(() => authenticatedDecoder.push(authenticatedHeader)).toThrow("16777216 byte limit");
  });

  it("rejects malformed JSON and unversioned payloads", () => {
    const decoder = new HostIpcFrameDecoder();
    const malformed = Buffer.from("not-json");
    const frame = Buffer.alloc(4 + malformed.length);
    frame.writeUInt32LE(malformed.length);
    malformed.copy(frame, 4);
    expect(() => decoder.push(frame)).toThrow("not valid JSON");

    const unversioned = Buffer.from(JSON.stringify({ type: "auth.hello" }));
    const second = Buffer.alloc(4 + unversioned.length);
    second.writeUInt32LE(unversioned.length);
    unversioned.copy(second, 4);
    expect(() => new HostIpcFrameDecoder().push(second)).toThrow(
      "Unsupported IPC protocol version",
    );
  });
});

describe("Host IPC mutual authentication", () => {
  it("authenticates both sides with client and server nonces", () => {
    const client = new HostIpcClientAuthenticator(capability, () => 1_000, sequenceRandom(1));
    const server = new HostIpcServerAuthenticator(
      (keyId) => (keyId === capability.keyId ? capability : undefined),
      () => 1_000,
      sequenceRandom(2, 3),
    );
    const hello = client.hello();
    const challenge = server.begin("connection-1", hello);
    expect(challenge.clientNonce).toBe(hello.clientNonce);
    expect(challenge.serverNonce).not.toBe(hello.clientNonce);
    const proof = client.answer(challenge);
    const { peer: authenticatedPeer, ready } = server.complete("connection-1", proof);
    expect(client.accept(ready)).toMatchObject({
      clientKind: "desktop",
      keyId: capability.keyId,
      sessionId: authenticatedPeer.sessionId,
    });
  });

  it("matches the native broker golden HMAC transcript", () => {
    const client = new HostIpcClientAuthenticator(capability, () => 1_000, sequenceRandom(1));
    const server = new HostIpcServerAuthenticator(
      () => capability,
      () => 1_000,
      sequenceRandom(2, 3),
    );
    const challenge = server.begin("connection-1", client.hello());
    expect(challenge.serverProof).toBe(
      "M8a3MPWUIj-WcZwO5fKnSLQyiXv_8JUCaA-9I_x5LHk",
    );
    expect(client.answer(challenge).clientProof).toBe(
      "LuGYzGfk4rnNbkkeJr0Q-8NnqQLCFzbl_mluP2YfY3A",
    );
  });

  it("does not allow a proof to cross transport connections", () => {
    const client = new HostIpcClientAuthenticator(capability, () => 1_000, sequenceRandom(1));
    const server = new HostIpcServerAuthenticator(
      () => capability,
      () => 1_000,
      sequenceRandom(2, 3),
    );
    const proof = client.answer(server.begin("connection-1", client.hello()));
    expect(() => server.complete("connection-2", proof)).toThrowError(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => server.complete("connection-1", proof)).not.toThrow();
  });

  it("uses timing-safe proof verification and rejects tampering on either side", () => {
    const server = new HostIpcServerAuthenticator(
      () => capability,
      () => 1_000,
      sequenceRandom(2, 3),
    );
    const client = new HostIpcClientAuthenticator(capability, () => 1_000, sequenceRandom(1));
    const challenge = server.begin("connection-1", client.hello());
    expect(() =>
      client.answer({ ...challenge, serverProof: mutateDigest(challenge.serverProof) }),
    ).toThrow("Server proof was rejected");

    const proof = client.answer(challenge);
    expect(() =>
      server.complete("connection-1", { ...proof, clientProof: mutateDigest(proof.clientProof) }),
    ).toThrow("Authentication proof was rejected");
  });

  it("rejects replayed nonces and a handshake that exceeds two seconds", () => {
    let now = 1_000;
    const server = new HostIpcServerAuthenticator(
      () => capability,
      () => now,
      sequenceRandom(2, 3, 4),
    );
    const client = new HostIpcClientAuthenticator(capability, () => now, sequenceRandom(1));
    const hello = client.hello();
    const challenge = server.begin("connection-1", hello);
    const proof = client.answer(challenge);
    expect(() => server.begin("connection-1", hello)).toThrowError(
      expect.objectContaining({ code: "request_replayed" }),
    );
    now = 3_001;
    expect(() => server.complete("connection-1", proof)).toThrowError(
      expect.objectContaining({ code: "request_timeout" }),
    );

    expect(() =>
      server.begin("connection-2", {
        ...hello,
        clientNonce: Buffer.alloc(32, 9).toString("base64url"),
      }),
    ).toThrowError(expect.objectContaining({ code: "request_timeout" }));
  });

  it("binds a key to its declared client kind and requires a 256-bit secret", () => {
    const server = new HostIpcServerAuthenticator(() => capability, () => 1_000);
    expect(() =>
      server.begin("connection-1", {
        ...new HostIpcClientAuthenticator(
          { ...capability, clientKind: "mcp" },
          () => 1_000,
          sequenceRandom(1),
        ).hello(),
      }),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(
      () =>
        new HostIpcClientAuthenticator({ ...capability, secret: Buffer.alloc(31) }),
    ).toThrow("at least 32 bytes");
  });
});

describe("Host IPC dispatcher", () => {
  function fixture(now = () => 1_000) {
    const callTool = vi.fn().mockResolvedValue({ ok: true });
    const status = vi.fn().mockResolvedValue({
      phase: "active",
      paired: true,
      acceptingWork: true,
      since: "2026-07-28T00:00:00.000Z",
    });
    const gracefulStop = vi.fn().mockResolvedValue(undefined);
    const application = { callTool } as unknown as Pick<HostApplication, "callTool">;
    return {
      callTool,
      status,
      gracefulStop,
      dispatcher: new HostIpcRequestDispatcher(application, { status, gracefulStop, now }),
    };
  }

  it("dispatches only direct allowlisted tool methods", async () => {
    const test = fixture();
    const result = await test.dispatcher.dispatch(
      peer("mcp"),
      request("collab_send_message", { params: { body: "hello" } }),
    );
    expect(result).toMatchObject({ ok: true, result: { ok: true } });
    expect(test.callTool).toHaveBeenCalledWith("collab_send_message", { body: "hello" });

    const denied = await test.dispatcher.dispatch(peer("mcp"), {
      ...request("host.status", { id: "request-2" }),
      method: "shell.exec",
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "method_not_allowed" } });
  });

  it("exposes status to both clients but graceful stop only to desktop", async () => {
    const test = fixture();
    await expect(
      test.dispatcher.dispatch(peer("mcp"), request("host.status")),
    ).resolves.toMatchObject({ ok: true, result: { phase: "active" } });

    const denied = await test.dispatcher.dispatch(
      peer("mcp"),
      request("host.gracefulStop", { id: "request-2" }),
    );
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(test.gracefulStop).not.toHaveBeenCalled();

    await expect(
      test.dispatcher.dispatch(
        peer("desktop"),
        request("host.gracefulStop", { id: "request-3" }),
      ),
    ).resolves.toMatchObject({ ok: true, result: { stopping: true } });
    expect(test.gracefulStop).toHaveBeenCalledTimes(1);
  });

  it("does not give the desktop capability access to MCP tools", async () => {
    const test = fixture();
    for (const method of ["collab_create_session", "collab_write_file"] as const) {
      const denied = await test.dispatcher.dispatch(
        peer("desktop"),
        request(method, { id: `desktop-${method}` }),
      );
      expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(test.callTool).not.toHaveBeenCalled();
  });

  it("returns the same receipt for an exact retry and rejects id reuse", async () => {
    const test = fixture();
    const first = await test.dispatcher.dispatch(peer(), request("host.status"));
    await expect(
      test.dispatcher.dispatch(peer(), request("host.status")),
    ).resolves.toEqual(first);
    expect(test.status).toHaveBeenCalledTimes(1);
    await expect(
      test.dispatcher.dispatch(
        peer(),
        request("host.status", { params: { changed: true } }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "request_replayed" } });
    await expect(
      test.dispatcher.dispatch(
        peer(),
        request("host.status", { id: "expired", sentAt: 900, timeoutMs: 50 }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "request_timeout" } });
  });

  it("bounds concurrent work per authenticated capability", async () => {
    const test = fixture();
    const resolvers: Array<(value: unknown) => void> = [];
    test.callTool.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const running = Array.from({ length: 8 }, (_, index) =>
      test.dispatcher.dispatch(
        peer("mcp"),
        request("collab_health", { id: `running-${index}` }),
      ),
    );
    await vi.waitFor(() => expect(test.callTool).toHaveBeenCalledTimes(8));
    await expect(
      test.dispatcher.dispatch(
        peer("mcp"),
        request("collab_health", { id: "running-overflow" }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { message: "Host IPC is busy" } });
    for (const resolve of resolvers) resolve({ ok: true });
    await Promise.all(running);
  });

});

describe("Host IPC client protocol", () => {
  it("does not create requests before auth and rejects replayed responses", () => {
    const client = new HostIpcClientProtocol(capability, () => 1_000, sequenceRandom(1));
    expect(() => client.request("host.status", {})).toThrow("not authenticated");
    const server = new HostIpcServerAuthenticator(
      () => capability,
      () => 1_000,
      sequenceRandom(2, 3),
    );
    const challenge = server.begin("connection-1", client.hello());
    const authenticated = server.complete(
      "connection-1",
      client.answerChallenge(challenge),
    );
    client.acceptReady(authenticated.ready);
    const outgoing = client.request("host.status", {});
    const response = { v: 1 as const, type: "response" as const, id: outgoing.id, ok: true as const, result: {} };
    expect(client.acceptResponse(response)).toEqual(response);
    expect(() => client.acceptResponse(response)).toThrowError(
      expect.objectContaining({ code: "request_replayed" }),
    );
  });
});

function mutateDigest(value: string): string {
  return `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;
}
