import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type {
  Member,
  Message,
  Session,
  WorkspaceSummary,
} from "@codex-collab/protocol";
import { isCredentialRejected } from "../../shared/api/api-client.js";
import {
  getDashboardRuntime,
  RuntimeRequestError,
  type RuntimeRealtimeEventV1,
} from "../../shared/runtime/index.js";
import type { ActivityItem } from "../activity/ActivityPanel.js";
import type { ConnectionState } from "../../app/connection.js";
import type { SavedCredential } from "../session/session-storage.js";
import { shouldRefreshRealtimeHistory } from "./realtime-history-refresh.js";
import { realtimeNotification } from "./realtime-notifications.js";

interface RealtimeConnectionOptions {
  session: Session | null;
  authorization?: string;
  credentialAvailable: boolean;
  approved: boolean;
  credentialValidated: boolean;
  member: Member | null;
  addMessage: (message: Message) => void;
  pushActivity: (
    title: string,
    detail: string,
    tone?: ActivityItem["tone"],
  ) => void;
  refresh: () => Promise<void>;
  refreshWorkspace: (includeHistory?: boolean) => Promise<WorkspaceSummary | null>;
  saveCredential: (credential: SavedCredential) => void;
  showError: (error: unknown) => void;
  setConnection: Dispatch<SetStateAction<ConnectionState>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setInviteOpen: Dispatch<SetStateAction<boolean>>;
  setWorkspaceSummary: Dispatch<SetStateAction<WorkspaceSummary | null>>;
  workspaceHistoryRequestedAtRef: RefObject<number>;
}

export function useRealtimeConnection({
  session,
  authorization,
  credentialAvailable,
  approved,
  credentialValidated,
  member,
  addMessage,
  pushActivity,
  refresh,
  refreshWorkspace,
  saveCredential,
  showError,
  setConnection,
  setError,
  setInviteOpen,
  setWorkspaceSummary,
  workspaceHistoryRequestedAtRef,
}: RealtimeConnectionOptions): void {
  useEffect(() => {
    if (!session || !credentialAvailable || !member || !approved || !credentialValidated) {
      return;
    }
    let stopped = false;
    let realtime: { close(): Promise<void> } | null = null;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let connecting = false;

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer !== undefined) return;
      const base = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (stopped || connecting) return;
      connecting = true;
      setConnection("connecting");
      try {
        const handleEvent = (event: RuntimeRealtimeEventV1) => {
          if (stopped) return;
          if (event.type === "open") {
            reconnectAttempt = 0;
            setConnection("live");
            setError(null);
            return;
          }
          if (event.type === "close") {
            realtime = null;
            if (event.code === 4001) {
              setConnection("error");
              return;
            }
            setConnection("connecting");
            scheduleReconnect();
            return;
          }
          if (event.type === "error") {
            setConnection("error");
            return;
          }
          const envelope = event.envelope;
          const notification = realtimeNotification(envelope, member);
          if (notification) {
            void getDashboardRuntime().shell.notify(notification).catch(() => undefined);
          }
          if (envelope.type === "message.created") {
            const next = envelope.payload as Message;
            addMessage(next);
            pushActivity("收到新消息", next.senderDisplayName, "info");
          }
          if (envelope.type === "member.updated") {
            const next = envelope.payload as Member;
            pushActivity("成员状态已变化", next.displayName, "success");
            void refresh();
          }
          if (envelope.type === "session.updated") {
            const next = envelope.payload as Session;
            saveCredential(
              authorization
                ? {
                    session: next,
                    member,
                    authorization: {
                      kind: "browser-bearer",
                      bearerToken: authorization,
                    },
                  }
                : {
                    session: next,
                    member,
                    authorization: { kind: "desktop-managed" },
                  },
            );
            if (next.roomStatus === "closed") setInviteOpen(false);
            pushActivity(
              next.roomStatus === "open" ? "房间已开启" : "房间已关闭",
              next.roomStatus === "open"
                ? "成员可以继续发送消息和 Codex 指令"
                : "历史记录仍可查看，新的协作操作已暂停",
              next.roomStatus === "open" ? "success" : "warning",
            );
          }
          if (envelope.type === "workspace.updated") {
            pushActivity("共享工作区已更新", "Codex 记录或文件发生变化", "success");
            const payload = envelope.payload as {
              changedScopes?: string[];
              codexRuntimeStatus?: WorkspaceSummary["codexRuntimeStatus"];
            };
            const scopes = payload.changedScopes ?? [];
            if (
              scopes.length === 1 &&
              scopes[0] === "runtime" &&
              payload.codexRuntimeStatus
            ) {
              setWorkspaceSummary((current) =>
                current
                  ? { ...current, codexRuntimeStatus: payload.codexRuntimeStatus! }
                  : current,
              );
              if (payload.codexRuntimeStatus === "running") {
                workspaceHistoryRequestedAtRef.current = 0;
                return;
              }
            }
            const historyChanged =
              scopes.length === 0 ||
              scopes.includes("history") ||
              scopes.includes("selection");
            const terminalRuntime =
              scopes.includes("runtime") &&
              payload.codexRuntimeStatus !== undefined &&
              payload.codexRuntimeStatus !== "running";
            const includeHistory =
              terminalRuntime ||
              (historyChanged &&
                shouldRefreshRealtimeHistory(
                  workspaceHistoryRequestedAtRef.current,
                  Date.now(),
                ));
            if (includeHistory) workspaceHistoryRequestedAtRef.current = Date.now();
            void refreshWorkspace(includeHistory).catch(showError);
          }
          if (envelope.type === "file.operation.updated") {
            void refreshWorkspace(false).catch(showError);
          }
        };
        realtime = await getDashboardRuntime().connectRealtime(
          { sessionId: session.id, authorization },
          { onEvent: handleEvent },
        );
      } catch (caught) {
        connecting = false;
        if (stopped) return;
        if (
          isCredentialRejected(caught) ||
          (caught instanceof RuntimeRequestError && caught.status === 403)
        ) {
          showError(caught);
          return;
        }
        setConnection("error");
        scheduleReconnect();
        return;
      }
      connecting = false;
      if (stopped) await realtime?.close();
    };

    void connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      void realtime?.close();
    };
  }, [
    addMessage,
    approved,
    authorization,
    credentialValidated,
    member,
    pushActivity,
    refresh,
    refreshWorkspace,
    saveCredential,
    session,
    showError,
    credentialAvailable,
  ]);


}
