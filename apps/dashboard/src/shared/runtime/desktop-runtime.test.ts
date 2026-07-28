import { describe, expect, it, vi } from "vitest";
import type { Member, Session } from "@codex-collab/protocol";
import type {
  CodexCollabDesktopApiV1,
  DesktopRealtimeEventV1,
} from "./desktop-contract.js";
import { createDesktopRuntime } from "./desktop-runtime.js";
import type { DesktopRelayOperationV1 } from "./types.js";

const session: Session = {
  id: "session-1",
  name: "Room",
  ownerMemberId: "member-1",
  roomStatus: "open",
  createdAt: "2026-07-28T00:00:00.000Z",
};
const member: Member = {
  id: "member-1",
  sessionId: session.id,
  displayName: "Owner",
  deviceLabel: "Desktop",
  role: "owner",
  status: "approved",
  workspaceFileAccess: "workspace-write",
  createdAt: session.createdAt,
  approvedAt: session.createdAt,
};

function bridgeFixture() {
  let realtimeListener: ((event: DesktopRealtimeEventV1) => void) | null = null;
  let hostStatusListener: Parameters<
    CodexCollabDesktopApiV1["host"]["onStatus"]
  >[0] | null = null;
  const performMock = vi.fn(async (_operation: DesktopRelayOperationV1) => ({
    ok: true as const,
    value: { status: 200, body: { member, session }, json: true },
  }));
  const perform = ((operation: Parameters<
    CodexCollabDesktopApiV1["relay"]["perform"]
  >[0]) => performMock(operation)) as CodexCollabDesktopApiV1["relay"]["perform"];
  const updateSnapshot = vi.fn(async () => ({ ok: true as const, value: null }));
  const openExternal = vi.fn(async () => ({ ok: true as const, value: null }));
  const notify = vi.fn(async () => ({ ok: true as const, value: null }));
  const bridge: CodexCollabDesktopApiV1 = {
    version: 1,
    getRuntimeInfo: async () => ({
      ok: true,
      value: {
        platform: "win32",
        appVersion: "0.1.0-beta.1",
        deviceLabel: "Owner PC",
        publicRelayOrigin: "https://relay.example.test",
      },
    }),
    relay: {
      perform,
      downloadMessageAttachment: async () => ({
        ok: true,
        value: new Uint8Array([1, 2, 3]).buffer,
      }),
    },
    realtime: {
      connect: async () => ({
        ok: true,
        value: { connectionId: "connection-1" },
      }),
      close: async () => ({ ok: true, value: null }),
      onEvent(listener) {
        realtimeListener = listener;
        return () => {
          realtimeListener = null;
        };
      },
    },
    credentials: {
      load: async () => ({ ok: true, value: { session, member } }),
      updateSnapshot,
      clear: async () => ({ ok: true, value: null }),
    },
    host: {
      getStatus: async () => ({
        ok: true,
        value: {
          version: 1,
          phase: "active",
          paired: true,
          acceptingWork: true,
          since: "2026-07-28T00:00:00.000Z",
        },
      }),
      onStatus(listener) {
        hostStatusListener = listener;
        return () => {
          hostStatusListener = null;
        };
      },
    },
    shell: { openExternal, notify },
  };
  return {
    bridge,
    perform: performMock,
    updateSnapshot,
    openExternal,
    notify,
    emit(event: DesktopRealtimeEventV1) {
      realtimeListener?.(event);
    },
    emitHostStatus(status: Parameters<NonNullable<typeof hostStatusListener>>[0]) {
      hostStatusListener?.(status);
    },
  };
}

describe("desktop Dashboard runtime", () => {
  it("strips browser authorization before crossing preload", async () => {
    const setup = bridgeFixture();
    const runtime = await createDesktopRuntime(setup.bridge);

    await runtime.request({
      operation: "session.me.get",
      sessionId: session.id,
      authorization: "must-not-cross-preload",
    });

    expect(setup.perform).toHaveBeenCalledWith({
      operation: "session.me.get",
      sessionId: session.id,
    });
    expect(JSON.stringify(setup.perform.mock.calls)).not.toContain(
      "must-not-cross-preload",
    );
  });

  it("exposes only opaque desktop credential state to the renderer", async () => {
    const setup = bridgeFixture();
    const runtime = await createDesktopRuntime(setup.bridge);
    const credential = await runtime.credentials.load();

    expect(credential).toEqual({
      session,
      member,
      authorization: { kind: "desktop-managed" },
    });
    await runtime.credentials.save(credential!);
    expect(setup.updateSnapshot).toHaveBeenCalledWith({ session, member });
    expect(JSON.stringify(credential)).not.toContain("token");
  });

  it("opens realtime by session id without a renderer ticket", async () => {
    const setup = bridgeFixture();
    const runtime = await createDesktopRuntime(setup.bridge);
    const onEvent = vi.fn();
    const connection = await runtime.connectRealtime(
      { sessionId: session.id, authorization: "browser-only" },
      { onEvent },
    );
    setup.emit({ connectionId: "connection-1", event: { type: "open" } });

    expect(onEvent).toHaveBeenCalledWith({ type: "open" });
    expect(JSON.stringify(setup.bridge.realtime)).not.toContain("browser-only");
    await connection.close();
  });

  it("forwards only the narrow versioned Host status capability", async () => {
    const setup = bridgeFixture();
    const runtime = await createDesktopRuntime(setup.bridge);
    const listener = vi.fn();
    const unsubscribe = runtime.host.onStatus(listener);

    await expect(runtime.host.getStatus()).resolves.toMatchObject({
      version: 1,
      phase: "active",
      acceptingWork: true,
    });
    setup.emitHostStatus({
      status: {
        version: 1,
        phase: "suspended",
        paired: true,
        acceptingWork: false,
        since: "2026-07-28T00:05:00.000Z",
      },
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "suspended", acceptingWork: false }),
    );
    unsubscribe();
  });

  it("forwards only narrow shell actions through preload", async () => {
    const setup = bridgeFixture();
    const runtime = await createDesktopRuntime(setup.bridge);

    await runtime.shell.openExternal("https://docs.example.test/guide");
    await runtime.shell.notify({ title: "New message", body: "Open the room." });

    expect(setup.openExternal).toHaveBeenCalledWith(
      "https://docs.example.test/guide",
    );
    expect(setup.notify).toHaveBeenCalledWith({
      title: "New message",
      body: "Open the room.",
    });
  });

  it("rejects a non-HTTPS public invite origin", async () => {
    const setup = bridgeFixture();
    setup.bridge.getRuntimeInfo = async () => ({
      ok: true,
      value: {
        platform: "win32",
        appVersion: "0.1.0-beta.1",
        deviceLabel: "Owner PC",
        publicRelayOrigin: "http://relay.example.test",
      },
    });
    await expect(createDesktopRuntime(setup.bridge)).rejects.toThrow("必须使用 HTTPS");
  });
});
