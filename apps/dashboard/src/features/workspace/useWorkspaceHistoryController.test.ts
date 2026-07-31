import { describe, expect, it, vi } from "vitest";
import type {
  Session,
  WorkspaceHistoryPage,
  WorkspaceOverview,
} from "@codex-collab/protocol";

const { requestJsonMock } = vi.hoisted(() => ({
  requestJsonMock: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useCallback: <T,>(callback: T) => callback,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useRef: <T,>(current: T) => ({ current }),
    useState: <T,>(initial: T | (() => T)) => [
      typeof initial === "function" ? (initial as () => T)() : initial,
      vi.fn(),
    ],
  };
});

vi.mock("../../shared/api/api-client.js", () => ({
  requestJson: requestJsonMock,
}));

import { useWorkspaceHistoryController } from "./useWorkspaceHistoryController.js";

const session: Session = {
  id: "session-1",
  name: "Room",
  ownerMemberId: "owner-1",
  roomStatus: "open",
  createdAt: "2026-07-31T00:00:00.000Z",
};

const overview: WorkspaceOverview = {
  hostConnected: true,
  hostGeneration: "generation-1",
  hostDeviceLabel: "Owner PC",
  rootLabel: "project",
  threads: [],
  selectedThreadId: "thread-1",
  selectedThread: null,
  files: [],
  historyCount: 1,
  codexRuntimeStatus: "idle",
  syncedAt: "2026-07-31T00:00:00.000Z",
};

const stalePage: WorkspaceHistoryPage = {
  selectedThreadId: "thread-1",
  items: [],
  totalCount: 0,
  hasOlder: false,
  olderCursor: null,
  syncedAt: "2026-07-31T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createController() {
  return useWorkspaceHistoryController({
    approved: true,
    authHeaders: () => ({}),
    messageStreamRef: { current: null },
    onError: vi.fn(),
    session,
    setConversationLoading: vi.fn(),
    token: "test-token",
  });
}

describe("useWorkspaceHistoryController refresh coalescing", () => {
  it("runs one trailing history request when final history arrives during a stale request", async () => {
    const firstHistory = deferred<{ workspaceHistoryPage: WorkspaceHistoryPage }>();
    let historyRequests = 0;
    requestJsonMock.mockImplementation((path: string) => {
      if (path.endsWith("/workspace/overview")) {
        return Promise.resolve({ workspace: overview });
      }
      historyRequests += 1;
      return historyRequests === 1
        ? firstHistory.promise
        : Promise.resolve({
            workspaceHistoryPage: {
              ...stalePage,
              totalCount: 1,
              items: [
                {
                  key: "answer-1",
                  entry: {
                    id: "answer-1",
                    role: "assistant",
                    phase: "final_answer",
                    text: "完成",
                    createdAt: "2026-07-31T00:00:01.000Z",
                  },
                },
              ],
            },
          });
    });
    const controller = createController();

    const first = controller.refresh(true);
    await vi.waitFor(() => expect(historyRequests).toBe(1));
    const second = controller.refresh(true);
    const third = controller.refresh(true);
    firstHistory.resolve({ workspaceHistoryPage: stalePage });

    await Promise.all([first, second, third]);
    await vi.waitFor(() => expect(historyRequests).toBe(2));
    expect(requestJsonMock).toHaveBeenCalledTimes(4);
  });

  it("does not run a trailing request after reset cancels the workspace epoch", async () => {
    const firstHistory = deferred<{ workspaceHistoryPage: WorkspaceHistoryPage }>();
    let historyRequests = 0;
    requestJsonMock.mockImplementation((path: string) => {
      if (path.endsWith("/workspace/overview")) {
        return Promise.resolve({ workspace: overview });
      }
      historyRequests += 1;
      return firstHistory.promise;
    });
    const controller = createController();

    const first = controller.refresh(true);
    await vi.waitFor(() => expect(historyRequests).toBe(1));
    void controller.refresh(true);
    controller.reset();
    firstHistory.resolve({ workspaceHistoryPage: stalePage });

    await first;
    await Promise.resolve();
    expect(historyRequests).toBe(1);
  });
});
