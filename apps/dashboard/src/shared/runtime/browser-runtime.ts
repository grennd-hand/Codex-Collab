import type { RealtimeTicketResponse } from "@codex-collab/protocol";
import { relayOperationRequest } from "./relay-operation.js";
import {
  DASHBOARD_RUNTIME_VERSION,
  RuntimeRequestError,
  type BrowserCredentialV1,
  type DashboardCredentialV1,
  type DashboardRuntimeV1,
  type RuntimeNotificationV1,
  type RuntimeResponseV1,
} from "./types.js";

const SESSION_STORAGE_KEY = "codexCollab";

interface LegacySavedCredential {
  session?: BrowserCredentialV1["session"];
  member?: BrowserCredentialV1["member"];
  token?: string;
}

export interface BrowserRuntimeEnvironment {
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
  location: Pick<Location, "hash" | "host" | "hostname" | "origin" | "pathname" | "protocol" | "search">;
  history: Pick<History, "replaceState">;
  navigator: Pick<Navigator, "platform">;
  sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  openExternal?: (url: string) => void;
  notify?: (notification: RuntimeNotificationV1) => void;
}

export function bindBrowserFetch(
  browserWindow: Pick<Window, "fetch"> | null,
  fallbackFetch: typeof fetch,
): typeof fetch {
  return browserWindow
    ? browserWindow.fetch.bind(browserWindow)
    : fallbackFetch;
}

function defaultEnvironment(): BrowserRuntimeEnvironment {
  const memory = new Map<string, string>();
  const browserWindow = typeof window === "undefined" ? null : window;
  const runtimeLocation = browserWindow?.location ?? {
    hash: "",
    host: "localhost",
    hostname: "localhost",
    origin: "http://localhost",
    pathname: "/",
    protocol: "http:",
    search: "",
  };
  const runtimeStorage = browserWindow?.sessionStorage ?? {
    getItem(key: string) {
      return memory.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      memory.set(key, value);
    },
    removeItem(key: string) {
      memory.delete(key);
    },
  };
  return {
    fetch: bindBrowserFetch(browserWindow, globalThis.fetch),
    WebSocket: globalThis.WebSocket,
    location: runtimeLocation,
    history: browserWindow?.history ?? { replaceState() {} },
    navigator: globalThis.navigator ?? { platform: "Web device" },
    sessionStorage: runtimeStorage,
    openExternal(url) {
      const opened = browserWindow?.open(url, "_blank", "noopener,noreferrer");
      if (opened) opened.opener = null;
    },
    notify(notification) {
      if (
        browserWindow?.document.visibilityState === "hidden" &&
        browserWindow.Notification.permission === "granted"
      ) {
        new browserWindow.Notification(notification.title, {
          body: notification.body,
        });
      }
    },
  };
}

async function responseBody(response: Response): Promise<RuntimeResponseV1> {
  try {
    return { status: response.status, body: await response.json(), json: true };
  } catch {
    return { status: response.status, body: null, json: false };
  }
}

function parseCredential(raw: string | null): BrowserCredentialV1 | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as DashboardCredentialV1 | LegacySavedCredential;
  const token =
    "authorization" in parsed && parsed.authorization?.kind === "browser-bearer"
      ? parsed.authorization.bearerToken
      : "token" in parsed
        ? parsed.token
        : undefined;
  if (!parsed.session?.id || !parsed.member?.id || !token) {
    throw new Error("invalid saved session");
  }
  return {
    session: parsed.session,
    member: parsed.member,
    authorization: { kind: "browser-bearer", bearerToken: token },
  };
}

function apiError(response: RuntimeResponseV1): RuntimeRequestError {
  const body = response.body as {
    error?: { code?: string; message?: string };
  } | null;
  return new RuntimeRequestError(
    response.status,
    body?.error?.code ?? "request_failed",
    body?.error?.message ?? "请求未完成",
  );
}

export function createBrowserRuntime(
  environment: BrowserRuntimeEnvironment = defaultEnvironment(),
): DashboardRuntimeV1 {
  const inviteParameters = new URLSearchParams(environment.location.hash.slice(1));
  const inviteToken = inviteParameters.get("invite")?.trim() ?? "";
  const isLoopbackOrigin = ["127.0.0.1", "localhost", "::1"].includes(
    environment.location.hostname,
  );

  const runtime: DashboardRuntimeV1 = {
    version: DASHBOARD_RUNTIME_VERSION,
    kind: "browser",
    deviceLabel: environment.navigator.platform || "Web device",
    publicRelayOrigin: environment.location.origin,
    inviteToken,
    isLoopbackOrigin,
    async request(operation, signal) {
      const { path, init } = relayOperationRequest(operation);
      return responseBody(await environment.fetch(path, { ...init, signal }));
    },
    async downloadMessageAttachment(input) {
      const response = await environment.fetch(
        `/v1/sessions/${encodeURIComponent(input.sessionId)}/messages/${encodeURIComponent(
          input.messageId,
        )}/attachments/${encodeURIComponent(input.attachmentId)}`,
        {
          headers: input.authorization
            ? { authorization: `Bearer ${input.authorization}` }
            : undefined,
          signal: input.signal,
        },
      );
      if (!response.ok) {
        throw new RuntimeRequestError(
          response.status,
          "attachment_read_failed",
          `附件读取失败（HTTP ${response.status}）`,
        );
      }
      return response.blob();
    },
    async connectRealtime(input, callbacks) {
      const ticketResponse = await runtime.request({
        operation: "realtime.ticket.create",
        sessionId: input.sessionId,
        authorization: input.authorization,
      });
      if (ticketResponse.status < 200 || ticketResponse.status >= 300) {
        throw apiError(ticketResponse);
      }
      if (!ticketResponse.json) {
        throw new RuntimeRequestError(
          ticketResponse.status,
          "invalid_response",
          "Relay 返回了无法读取的响应",
        );
      }
      const { ticket } = ticketResponse.body as RealtimeTicketResponse;
      if (!ticket) {
        throw new RuntimeRequestError(
          ticketResponse.status,
          "invalid_response",
          "Relay 没有返回实时连接票据",
        );
      }
      const protocol = environment.location.protocol === "https:" ? "wss:" : "ws:";
      const query = new URLSearchParams({ ticket });
      const socket = new environment.WebSocket(
        `${protocol}//${environment.location.host}/v1/realtime?${query.toString()}`,
      );
      socket.addEventListener("open", () => callbacks.onEvent({ type: "open" }));
      socket.addEventListener("message", (event) => {
        callbacks.onEvent({
          type: "message",
          envelope: JSON.parse(event.data as string),
        });
      });
      socket.addEventListener("close", (event) => {
        callbacks.onEvent({ type: "close", code: event.code });
      });
      socket.addEventListener("error", () => callbacks.onEvent({ type: "error" }));
      return {
        async close() {
          socket.close();
        },
      };
    },
    credentials: {
      async load() {
        try {
          return parseCredential(environment.sessionStorage.getItem(SESSION_STORAGE_KEY));
        } catch {
          environment.sessionStorage.removeItem(SESSION_STORAGE_KEY);
          return null;
        }
      },
      async save(credential) {
        if (credential.authorization.kind !== "browser-bearer") {
          throw new Error("浏览器不能保存桌面托管凭据");
        }
        environment.sessionStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify(credential),
        );
      },
      async clear() {
        environment.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      },
    },
    host: {
      async getStatus() {
        return null;
      },
      onStatus() {
        return () => undefined;
      },
    },
    shell: {
      async openExternal(rawUrl) {
        let url: URL;
        try {
          url = new URL(rawUrl);
        } catch {
          throw new Error("external_url_rejected");
        }
        if (url.protocol !== "https:" || url.username || url.password) {
          throw new Error("external_url_rejected");
        }
        environment.openExternal?.(url.toString());
      },
      async notify(notification) {
        environment.notify?.(notification);
      },
    },
    clearInviteLocation() {
      environment.history.replaceState(
        null,
        "",
        `${environment.location.pathname}${environment.location.search}`,
      );
    },
  };
  return runtime;
}
