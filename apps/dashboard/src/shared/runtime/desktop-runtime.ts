import type { CodexCollabDesktopApiV1 } from "./desktop-contract.js";
import {
  DASHBOARD_RUNTIME_VERSION,
  RuntimeRequestError,
  type DashboardRuntimeV1,
  type DesktopRelayOperationV1,
  type RuntimeResultV1,
} from "./types.js";

function unwrap<T>(result: RuntimeResultV1<T>): T {
  if (result.ok) return result.value;
  throw new RuntimeRequestError(
    result.error.status,
    result.error.code,
    result.error.message,
  );
}

function withoutAuthorization(
  operation: Parameters<DashboardRuntimeV1["request"]>[0],
): DesktopRelayOperationV1 {
  if (operation.operation === "realtime.ticket.create") {
    throw new Error("桌面端实时票据只能由 Main 进程申请");
  }
  const { authorization: _authorization, ...safeOperation } = operation as
    Parameters<DashboardRuntimeV1["request"]>[0] & { authorization?: string };
  return safeOperation as DesktopRelayOperationV1;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export async function createDesktopRuntime(
  bridge: CodexCollabDesktopApiV1,
): Promise<DashboardRuntimeV1> {
  if (bridge.version !== DASHBOARD_RUNTIME_VERSION) {
    throw new Error(`不支持的 Codex Collab Desktop API 版本：${bridge.version}`);
  }
  const info = unwrap(await bridge.getRuntimeInfo());
  const publicRelayOrigin = new URL(info.publicRelayOrigin);
  if (publicRelayOrigin.protocol !== "https:") {
    throw new Error("桌面端公开 Relay 地址必须使用 HTTPS");
  }

  return {
    version: DASHBOARD_RUNTIME_VERSION,
    kind: "desktop",
    deviceLabel: info.deviceLabel,
    publicRelayOrigin: publicRelayOrigin.origin,
    inviteToken: "",
    isLoopbackOrigin: false,
    async request(operation, signal) {
      if (signal?.aborted) throw abortError();
      const pending = bridge.relay.perform(
        withoutAuthorization(operation),
      );
      const response = unwrap(await pending);
      if (signal?.aborted) throw abortError();
      return response;
    },
    async downloadMessageAttachment(input) {
      if (input.signal?.aborted) throw abortError();
      const result = unwrap(
        await bridge.relay.downloadMessageAttachment({
          sessionId: input.sessionId,
          messageId: input.messageId,
          attachmentId: input.attachmentId,
        }),
      );
      if (input.signal?.aborted) throw abortError();
      return new Blob([result]);
    },
    async connectRealtime(input, callbacks) {
      let connectionId: string | null = null;
      const pendingEvents: Parameters<
        CodexCollabDesktopApiV1["realtime"]["onEvent"]
      >[0] extends (event: infer T) => void ? T[] : never = [];
      const unsubscribe = bridge.realtime.onEvent((message) => {
        if (connectionId === null) {
          pendingEvents.push(message);
          return;
        }
        if (message.connectionId === connectionId) callbacks.onEvent(message.event);
      });
      try {
        connectionId = unwrap(
          await bridge.realtime.connect({ sessionId: input.sessionId }),
        ).connectionId;
        for (const message of pendingEvents) {
          if (message.connectionId === connectionId) callbacks.onEvent(message.event);
        }
      } catch (caught) {
        unsubscribe();
        throw caught;
      }
      let closed = false;
      return {
        async close() {
          if (closed) return;
          closed = true;
          unsubscribe();
          unwrap(await bridge.realtime.close(connectionId!));
        },
      };
    },
    credentials: {
      async load() {
        const snapshot = unwrap(await bridge.credentials.load());
        return snapshot
          ? { ...snapshot, authorization: { kind: "desktop-managed" as const } }
          : null;
      },
      async save(credential) {
        unwrap(
          await bridge.credentials.updateSnapshot({
            session: credential.session,
            member: credential.member,
          }),
        );
      },
      async clear() {
        unwrap(await bridge.credentials.clear());
      },
    },
    host: {
      async getStatus() {
        return unwrap(await bridge.host.getStatus());
      },
      onStatus(listener) {
        return bridge.host.onStatus((event) => listener(event.status));
      },
    },
    shell: {
      async openExternal(url) {
        unwrap(await bridge.shell.openExternal(url));
      },
      async notify(notification) {
        unwrap(await bridge.shell.notify(notification));
      },
    },
    clearInviteLocation() {
      // Desktop invitation links open in the collaborator's browser.
    },
  };
}
