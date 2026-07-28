import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalProfile } from "../local-profile.js";
import { HostRuntime, type HostRuntimeOptions } from "./host-runtime.js";

class FakeRealtimeSocket {
  readyState: number = WebSocket.CONNECTING;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as (event: unknown) => void);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  emit(type: string, event: unknown = undefined): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const ownerProfile: LocalProfile = {
  relayUrl: "https://relay.example/",
  sessionId: "session-1",
  memberId: "owner-1",
  displayName: "Owner",
  role: "owner",
  memberToken: "host-token",
  projectRoot: "C:\\project",
};

function createFixture(profile: LocalProfile | null = ownerProfile) {
  const socket = new FakeRealtimeSocket();
  const socketUrls: URL[] = [];
  const processPendingFileOperations = vi.fn().mockResolvedValue(0);
  const sync = vi.fn().mockResolvedValue({});
  const forwardPendingCommand = vi.fn().mockResolvedValue(null);
  const cancelActiveWork = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  const createRealtimeTicket = vi.fn().mockResolvedValue({ ticket: "ticket-1" });
  const options = {
    application: {
      readRuntimeProfile: vi.fn().mockResolvedValue(profile),
      runBackgroundCycle: async () => {
        await processPendingFileOperations();
        await sync();
      },
      forwardPendingCommand,
      cancelActiveWork,
      close,
    },
    syncIntervalMs: 60_000,
    createRelayClient: () => ({ createRealtimeTicket }),
    createRealtimeSocket: (url: URL) => {
      socketUrls.push(url);
      return socket;
    },
  } satisfies HostRuntimeOptions;
  return {
    runtime: new HostRuntime(options),
    socket,
    socketUrls,
    processPendingFileOperations,
    sync,
    forwardPendingCommand,
    cancelActiveWork,
    close,
    createRealtimeTicket,
    emitReady(roomStatus: "open" | "closed") {
      socket.emit("message", {
        data: JSON.stringify({
          type: "ready",
          sessionId: "session-1",
          payload: { session: { roomStatus } },
        }),
      });
    },
    emitRoomStatus(roomStatus: "open" | "closed") {
      socket.emit("message", {
        data: JSON.stringify({
          type: "session.updated",
          sessionId: "session-1",
          payload: { roomStatus },
        }),
      });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HostRuntime", () => {
  it("waits for the room state before reconciling and connects with a one-time ticket", async () => {
    const fixture = createFixture();

    await fixture.runtime.start();

    expect(fixture.runtime.getPhase()).toBe("unpaired");
    expect(fixture.processPendingFileOperations).not.toHaveBeenCalled();
    expect(fixture.createRealtimeTicket).toHaveBeenCalledWith("session-1", "host-token");
    expect(fixture.socketUrls).toHaveLength(1);
    expect(fixture.socketUrls[0]?.toString()).toBe(
      "wss://relay.example/v1/realtime?ticket=ticket-1",
    );
    expect(fixture.socketUrls[0]?.searchParams.has("token")).toBe(false);

    fixture.emitReady("open");
    await vi.waitFor(() => expect(fixture.runtime.getPhase()).toBe("active"));
    expect(fixture.processPendingFileOperations).toHaveBeenCalledTimes(1);
    expect(fixture.sync).toHaveBeenCalledTimes(1);

    await fixture.runtime.stop();
  });

  it("routes realtime command and file events without accepting another session", async () => {
    const fixture = createFixture();
    await fixture.runtime.start();
    fixture.emitReady("open");
    await vi.waitFor(() => expect(fixture.runtime.getPhase()).toBe("active"));

    fixture.socket.emit("message", {
      data: JSON.stringify({
        type: "message.created",
        sessionId: "other-session",
        payload: {},
      }),
    });
    fixture.socket.emit("message", {
      data: JSON.stringify({
        type: "message.created",
        sessionId: "session-1",
        payload: {},
      }),
    });

    await vi.waitFor(() => expect(fixture.forwardPendingCommand).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(fixture.sync).toHaveBeenCalledTimes(2));

    fixture.socket.emit("message", {
      data: JSON.stringify({
        type: "file.operation.updated",
        sessionId: "session-1",
        payload: {},
      }),
    });
    await vi.waitFor(() => expect(fixture.sync).toHaveBeenCalledTimes(3));

    await fixture.runtime.stop();
  });

  it("does not open realtime for a non-owner profile", async () => {
    const fixture = createFixture({ ...ownerProfile, role: "editor" });

    await fixture.runtime.start();

    expect(fixture.runtime.getPhase()).toBe("unpaired");
    expect(fixture.sync).not.toHaveBeenCalled();
    expect(fixture.createRealtimeTicket).not.toHaveBeenCalled();
    expect(fixture.socketUrls).toHaveLength(0);
    await fixture.runtime.stop();
  });

  it("closes local resources once and rejects work after shutdown", async () => {
    const fixture = createFixture();
    await fixture.runtime.start();
    fixture.emitReady("open");
    await vi.waitFor(() => expect(fixture.runtime.getPhase()).toBe("active"));

    await fixture.runtime.stop();
    await fixture.runtime.stop();
    fixture.socket.emit("message", {
      data: JSON.stringify({
        type: "message.created",
        sessionId: "session-1",
        payload: {},
      }),
    });

    expect(fixture.socket.readyState).toBe(WebSocket.CLOSED);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.forwardPendingCommand).not.toHaveBeenCalled();
  });

  it("waits for an active background cycle before closing Codex resources", async () => {
    let finishCycle!: () => void;
    const cycle = new Promise<void>((resolve) => {
      finishCycle = resolve;
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const socket = new FakeRealtimeSocket();
    const runBackgroundCycle = vi.fn().mockReturnValue(cycle);
    const runtime = new HostRuntime({
      application: {
        readRuntimeProfile: vi.fn().mockResolvedValue(ownerProfile),
        runBackgroundCycle,
        forwardPendingCommand: vi.fn().mockResolvedValue(null),
        close,
      },
      syncIntervalMs: 60_000,
      createRelayClient: () => ({
        createRealtimeTicket: vi.fn().mockResolvedValue({ ticket: "ticket-1" }),
      }),
      createRealtimeSocket: () => socket,
    });

    await runtime.start();
    socket.emit("message", {
      data: JSON.stringify({
        type: "ready",
        sessionId: "session-1",
        payload: { session: { roomStatus: "open" } },
      }),
    });
    await vi.waitFor(() => expect(runBackgroundCycle).toHaveBeenCalledTimes(1));
    const stopping = runtime.stop();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    finishCycle();
    await stopping;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps only realtime control alive when the initial room is closed", async () => {
    const fixture = createFixture();
    await fixture.runtime.start();

    fixture.emitReady("closed");
    await vi.waitFor(() => expect(fixture.runtime.getPhase()).toBe("suspended"));
    expect(fixture.socket.readyState).toBe(WebSocket.CONNECTING);
    expect(fixture.sync).not.toHaveBeenCalled();

    fixture.socket.emit("message", {
      data: JSON.stringify({
        type: "message.created",
        sessionId: "session-1",
        payload: {},
      }),
    });
    fixture.socket.emit("message", {
      data: JSON.stringify({
        type: "file.operation.updated",
        sessionId: "session-1",
        payload: {},
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fixture.forwardPendingCommand).not.toHaveBeenCalled();
    expect(fixture.sync).not.toHaveBeenCalled();
    await fixture.runtime.stop();
  });

  it("drains an active atomic cycle, suspends, and reconciles once before resuming", async () => {
    let finishActiveCycle!: () => void;
    const activeCycle = new Promise<void>((resolve) => {
      finishActiveCycle = resolve;
    });
    const socket = new FakeRealtimeSocket();
    const cycles: Array<Promise<void>> = [Promise.resolve(), activeCycle, Promise.resolve()];
    const runBackgroundCycle = vi.fn().mockImplementation(
      () => cycles.shift() ?? Promise.resolve(),
    );
    const cancelActiveWork = vi.fn().mockResolvedValue(undefined);
    const runtime = new HostRuntime({
      application: {
        readRuntimeProfile: vi.fn().mockResolvedValue(ownerProfile),
        runBackgroundCycle,
        cancelActiveWork,
        forwardPendingCommand: vi.fn().mockResolvedValue(null),
        close: vi.fn().mockResolvedValue(undefined),
      },
      syncIntervalMs: 60_000,
      createRelayClient: () => ({
        createRealtimeTicket: vi.fn().mockResolvedValue({ ticket: "ticket-1" }),
      }),
      createRealtimeSocket: () => socket,
    });

    await runtime.start();
    socket.emit("message", {
      data: JSON.stringify({
        type: "ready",
        sessionId: "session-1",
        payload: { session: { roomStatus: "open" } },
      }),
    });
    await vi.waitFor(() => expect(runtime.getPhase()).toBe("active"));

    socket.emit("message", {
      data: JSON.stringify({
        type: "file.operation.updated",
        sessionId: "session-1",
        payload: {},
      }),
    });
    await vi.waitFor(() => expect(runBackgroundCycle).toHaveBeenCalledTimes(2));
    socket.emit("message", {
      data: JSON.stringify({
        type: "session.updated",
        sessionId: "session-1",
        payload: { roomStatus: "closed" },
      }),
    });

    expect(runtime.getPhase()).toBe("draining");
    await Promise.resolve();
    expect(runtime.getPhase()).toBe("draining");
    expect(cancelActiveWork).toHaveBeenCalledTimes(1);
    finishActiveCycle();
    await vi.waitFor(() => expect(runtime.getPhase()).toBe("suspended"));

    socket.emit("message", {
      data: JSON.stringify({
        type: "session.updated",
        sessionId: "session-1",
        payload: { roomStatus: "open" },
      }),
    });
    await vi.waitFor(() => expect(runtime.getPhase()).toBe("active"));
    expect(runBackgroundCycle).toHaveBeenCalledTimes(3);

    socket.emit("message", {
      data: JSON.stringify({
        type: "session.updated",
        sessionId: "session-1",
        payload: { roomStatus: "open" },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runBackgroundCycle).toHaveBeenCalledTimes(3);
    await runtime.stop();
  });

  it("converges to suspended when the room closes during catch-up", async () => {
    let finishCatchUp!: () => void;
    const catchUp = new Promise<void>((resolve) => {
      finishCatchUp = resolve;
    });
    const fixture = createFixture();
    fixture.sync.mockReturnValueOnce(catchUp);

    await fixture.runtime.start();
    fixture.emitReady("closed");
    await vi.waitFor(() => expect(fixture.runtime.getPhase()).toBe("suspended"));

    fixture.emitRoomStatus("open");
    await vi.waitFor(() => expect(fixture.runtime.getPhase()).toBe("catching-up"));
    await vi.waitFor(() => expect(fixture.sync).toHaveBeenCalledTimes(1));
    const cancellationsBeforeClose = fixture.cancelActiveWork.mock.calls.length;
    fixture.emitRoomStatus("closed");
    expect(fixture.runtime.getPhase()).toBe("draining");
    await vi.waitFor(() =>
      expect(fixture.cancelActiveWork).toHaveBeenCalledTimes(cancellationsBeforeClose + 1),
    );

    finishCatchUp();
    await vi.waitFor(() => expect(fixture.runtime.getPhase()).toBe("suspended"));
    expect(fixture.sync).toHaveBeenCalledTimes(1);
    await fixture.runtime.stop();
  });

  it("uses the explicit resume reconciliation hook before enabling heavy cycles", async () => {
    const socket = new FakeRealtimeSocket();
    const reconcileAfterResume = vi.fn().mockResolvedValue(undefined);
    const runBackgroundCycle = vi.fn().mockResolvedValue(undefined);
    const runtime = new HostRuntime({
      application: {
        readRuntimeProfile: vi.fn().mockResolvedValue(ownerProfile),
        runBackgroundCycle,
        reconcileAfterResume,
        forwardPendingCommand: vi.fn().mockResolvedValue(null),
        close: vi.fn().mockResolvedValue(undefined),
      },
      syncIntervalMs: 60_000,
      createRelayClient: () => ({
        createRealtimeTicket: vi.fn().mockResolvedValue({ ticket: "ticket-1" }),
      }),
      createRealtimeSocket: () => socket,
    });

    await runtime.start();
    socket.emit("message", {
      data: JSON.stringify({
        type: "ready",
        sessionId: "session-1",
        payload: { session: { roomStatus: "open" } },
      }),
    });
    await vi.waitFor(() => expect(runtime.getPhase()).toBe("active"));
    expect(reconcileAfterResume).toHaveBeenCalledTimes(1);
    expect(runBackgroundCycle).not.toHaveBeenCalled();

    socket.emit("message", {
      data: JSON.stringify({
        type: "file.operation.updated",
        sessionId: "session-1",
        payload: {},
      }),
    });
    await vi.waitFor(() => expect(runBackgroundCycle).toHaveBeenCalledTimes(1));
    await runtime.stop();
  });

  it("reports a failed catch-up and retries it on the next open control state", async () => {
    const socket = new FakeRealtimeSocket();
    const reportError = vi.fn();
    const reconcileAfterResume = vi
      .fn()
      .mockRejectedValueOnce(new Error("catch-up failed"))
      .mockResolvedValueOnce(undefined);
    const runtime = new HostRuntime({
      application: {
        readRuntimeProfile: vi.fn().mockResolvedValue(ownerProfile),
        runBackgroundCycle: vi.fn().mockResolvedValue(undefined),
        reconcileAfterResume,
        forwardPendingCommand: vi.fn().mockResolvedValue(null),
        close: vi.fn().mockResolvedValue(undefined),
      },
      syncIntervalMs: 60_000,
      createRelayClient: () => ({
        createRealtimeTicket: vi.fn().mockResolvedValue({ ticket: "ticket-1" }),
      }),
      createRealtimeSocket: () => socket,
      reportError,
    });

    await runtime.start();
    const openEnvelope = {
      data: JSON.stringify({
        type: "ready",
        sessionId: "session-1",
        payload: { session: { roomStatus: "open" } },
      }),
    };
    socket.emit("message", openEnvelope);
    await vi.waitFor(() => expect(runtime.getPhase()).toBe("failed"));
    expect(reportError).toHaveBeenCalledWith("[codex-collab resume]", expect.any(Error));

    socket.emit("message", openEnvelope);
    await vi.waitFor(() => expect(runtime.getPhase()).toBe("active"));
    expect(reconcileAfterResume).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it.each(["close", "error"] as const)(
    "leaves active on realtime %s and catches up after reconnect",
    async (eventType) => {
      const sockets: FakeRealtimeSocket[] = [];
      const reconcileAfterResume = vi.fn().mockResolvedValue(undefined);
      const runBackgroundCycle = vi.fn().mockResolvedValue(undefined);
      const runtime = new HostRuntime({
        application: {
          readRuntimeProfile: vi.fn().mockResolvedValue(ownerProfile),
          runBackgroundCycle,
          reconcileAfterResume,
          forwardPendingCommand: vi.fn().mockResolvedValue(null),
          close: vi.fn().mockResolvedValue(undefined),
        },
        syncIntervalMs: 60_000,
        random: () => -2,
        createRelayClient: () => ({
          createRealtimeTicket: vi.fn().mockResolvedValue({ ticket: "ticket-1" }),
        }),
        createRealtimeSocket: () => {
          const socket = new FakeRealtimeSocket();
          sockets.push(socket);
          return socket;
        },
      });

      await runtime.start();
      sockets[0]!.emit("message", {
        data: JSON.stringify({
          type: "ready",
          sessionId: "session-1",
          payload: { session: { roomStatus: "open" } },
        }),
      });
      await vi.waitFor(() => expect(runtime.getPhase()).toBe("active"));

      sockets[0]!.emit(eventType, eventType === "close" ? { code: 1006 } : undefined);
      expect(runtime.getPhase()).toBe("unpaired");
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      sockets[1]!.emit("message", {
        data: JSON.stringify({
          type: "ready",
          sessionId: "session-1",
          payload: { session: { roomStatus: "open" } },
        }),
      });

      await vi.waitFor(() => expect(runtime.getPhase()).toBe("active"));
      expect(reconcileAfterResume).toHaveBeenCalledTimes(2);
      expect(runBackgroundCycle).not.toHaveBeenCalled();
      await runtime.stop();
    },
  );
});
