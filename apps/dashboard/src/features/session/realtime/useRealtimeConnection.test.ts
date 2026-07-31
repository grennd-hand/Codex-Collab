import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member, Session, WorkspaceSummary } from "@codex-collab/protocol";

const testState = vi.hoisted(() => ({
  cleanup: undefined as undefined | (() => void),
  onEvent: undefined as undefined | ((event: unknown) => void),
  connectRealtime: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useEffect: (effect: () => void | (() => void)) => {
      testState.cleanup = effect() ?? undefined;
    },
  };
});

vi.mock("../../../shared/api/api-client.js", () => ({
  isCredentialRejected: () => false,
}));

vi.mock("../../../shared/runtime/index.js", () => ({
  RuntimeRequestError: class RuntimeRequestError extends Error {
    constructor(public readonly status: number) {
      super("runtime request failed");
    }
  },
  getDashboardRuntime: () => ({
    connectRealtime: testState.connectRealtime,
    shell: { notify: vi.fn().mockResolvedValue(undefined) },
  }),
}));

import { REALTIME_HISTORY_REFRESH_INTERVAL_MS } from "./realtime-history-refresh.js";
import { useRealtimeConnection } from "./useRealtimeConnection.js";

const session: Session = {
  id: "session-1",
  name: "Room",
  ownerMemberId: "owner-1",
  roomStatus: "open",
  createdAt: "2026-07-31T00:00:00.000Z",
};

const member: Member = {
  id: "owner-1",
  sessionId: "session-1",
  displayName: "Owner",
  deviceLabel: "Browser",
  role: "owner",
  status: "approved",
  workspaceFileAccess: "workspace-write",
  createdAt: "2026-07-31T00:00:00.000Z",
  approvedAt: "2026-07-31T00:00:00.000Z",
};

afterEach(() => {
  testState.cleanup?.();
  testState.cleanup = undefined;
  testState.onEvent = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useRealtimeConnection history scheduling", () => {
  it("retains a queued history refresh when runtime changes to running", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.setSystemTime(new Date("2026-07-31T00:00:10.000Z"));
    testState.connectRealtime.mockImplementation(async (_input, handlers) => {
      testState.onEvent = handlers.onEvent;
      return { close: vi.fn().mockResolvedValue(undefined) };
    });
    const refreshWorkspace = vi.fn().mockResolvedValue(null);
    const historyRequestedAtRef = {
      current: Date.now() - REALTIME_HISTORY_REFRESH_INTERVAL_MS + 100,
    };

    useRealtimeConnection({
      session,
      authorization: "browser-token",
      credentialAvailable: true,
      approved: true,
      credentialValidated: true,
      member,
      addMessage: vi.fn(),
      pushActivity: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
      refreshWorkspace,
      saveCredential: vi.fn(),
      showError: vi.fn(),
      setConnection: vi.fn(),
      setError: vi.fn(),
      setInviteOpen: vi.fn(),
      setWorkspaceSummary: vi.fn(),
      workspaceHistoryRequestedAtRef: historyRequestedAtRef,
    });
    await vi.waitFor(() => expect(testState.onEvent).toBeTypeOf("function"));

    testState.onEvent?.({
      type: "message",
      envelope: {
        type: "workspace.updated",
        sessionId: session.id,
        payload: { changedScopes: ["history"] },
      },
    });
    testState.onEvent?.({
      type: "message",
      envelope: {
        type: "workspace.updated",
        sessionId: session.id,
        payload: {
          changedScopes: ["runtime"],
          codexRuntimeStatus: "running" satisfies WorkspaceSummary["codexRuntimeStatus"],
        },
      },
    });

    await vi.advanceTimersByTimeAsync(REALTIME_HISTORY_REFRESH_INTERVAL_MS);

    expect(refreshWorkspace).toHaveBeenCalledWith(false);
    expect(refreshWorkspace).toHaveBeenCalledWith(true);
  });
});
