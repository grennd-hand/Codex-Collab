import type { App, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  CorruptCredentialError,
  CredentialEncryptionUnavailableError,
  type DesktopCredential,
  type EncryptedCredentialStore,
} from "../credentials/credential-store.js";
import {
  DESKTOP_IPC,
  type CredentialSnapshotV1,
  type DesktopRuntimeInfoV1,
  type RuntimeErrorV1,
  type RuntimeResultV1,
} from "./ipc-contract.js";
import {
  type DesktopRelayTransport,
  runtimeError,
} from "../relay/relay-http-client.js";
import type { DesktopRealtimeManager } from "../relay/realtime-manager.js";
import type { DesktopHostStatusControl } from "../host/host-lifecycle-control.js";
import {
  isTrustedRendererFrame,
  validatedExternalUrl,
  validatedNotification,
  type ValidatedDesktopNotification,
} from "../security/security-policy.js";

export interface DesktopIpcDependencies {
  app: App;
  ipcMain: IpcMain;
  relayOrigin: string;
  credentials: EncryptedCredentialStore;
  relay: DesktopRelayTransport;
  realtime: DesktopRealtimeManager;
  host: DesktopHostStatusControl;
  shell: {
    openExternal(url: string): Promise<void>;
    notify(notification: ValidatedDesktopNotification): void;
  };
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (
    !frame ||
    frame !== frame.top ||
    frame !== event.sender.mainFrame ||
    !isTrustedRendererFrame(frame.url)
  ) {
    throw new Error("desktop_ipc_sender_rejected");
  }
}

function register<T extends unknown[], R>(
  ipcMain: IpcMain,
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...arguments_: T) => Promise<R> | R,
): void {
  ipcMain.handle(channel, async (event, ...arguments_: T) => {
    assertTrustedSender(event);
    return handler(event, ...arguments_);
  });
}

function credentialError(caught: unknown): RuntimeErrorV1 {
  if (caught instanceof CorruptCredentialError) {
    return {
      status: 0,
      code: "credential_corrupt",
      message: "保存的主人会话已损坏，请使用恢复密钥重新连接。",
    };
  }
  if (caught instanceof CredentialEncryptionUnavailableError) {
    return {
      status: 0,
      code: "credential_encryption_unavailable",
      message: "Windows 安全凭据存储当前不可用。",
    };
  }
  return runtimeError(caught);
}

async function result<T>(
  operation: () => Promise<T> | T,
  errorMapper: (caught: unknown) => RuntimeErrorV1 = runtimeError,
): Promise<RuntimeResultV1<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (caught) {
    return { ok: false, error: errorMapper(caught) };
  }
}

function snapshot(value: unknown): CredentialSnapshotV1 {
  if (!value || typeof value !== "object") throw new Error("invalid_credential_snapshot");
  const candidate = value as Partial<CredentialSnapshotV1>;
  if (
    !candidate.session ||
    typeof candidate.session.id !== "string" ||
    !candidate.member ||
    typeof candidate.member.id !== "string" ||
    candidate.member.sessionId !== candidate.session.id
  ) {
    throw new Error("invalid_credential_snapshot");
  }
  return candidate as CredentialSnapshotV1;
}

function connectionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[a-f0-9-]+$/i.test(value)
  ) {
    throw new Error("realtime_connection_id_rejected");
  }
  return value;
}

export function registerDesktopIpc(dependencies: DesktopIpcDependencies): void {
  const { app, ipcMain, relayOrigin, credentials, relay, realtime, host, shell } = dependencies;

  register(ipcMain, DESKTOP_IPC.runtimeInfo, () =>
    result((): DesktopRuntimeInfoV1 => ({
      platform: "win32",
      appVersion: app.getVersion(),
      deviceLabel: process.env.COMPUTERNAME?.trim() || "Windows desktop",
      publicRelayOrigin: relayOrigin,
    })),
  );

  register(ipcMain, DESKTOP_IPC.credentialLoad, () =>
    result(async () => {
      const credential = await credentials.load();
      return credential
        ? { session: credential.session, member: credential.member }
        : null;
    }, credentialError),
  );

  register(
    ipcMain,
    DESKTOP_IPC.credentialUpdateSnapshot,
    (_event, value: unknown) =>
      result(async () => {
        const next = snapshot(value);
        const current = await credentials.load();
        if (
          !current ||
          current.session.id !== next.session.id ||
          current.member.id !== next.member.id
        ) {
          throw new Error("credential_snapshot_identity_mismatch");
        }
        const updated: DesktopCredential = {
          session: next.session,
          member: next.member,
          token: current.token,
        };
        await credentials.save(updated);
        return null;
      }, credentialError),
  );

  register(ipcMain, DESKTOP_IPC.credentialClear, () =>
    result(async () => {
      await realtime.closeAll();
      await credentials.clear();
      return null;
    }, credentialError),
  );

  register(ipcMain, DESKTOP_IPC.relayPerform, (_event, operation: unknown) =>
    result(() => relay.perform(operation)),
  );
  register(
    ipcMain,
    DESKTOP_IPC.relayDownloadAttachment,
    (_event, input: unknown) => result(() => relay.downloadMessageAttachment(input)),
  );
  register(ipcMain, DESKTOP_IPC.realtimeConnect, (_event, input: unknown) =>
    result(() => {
      if (!input || typeof input !== "object") throw new Error("invalid_realtime_request");
      return realtime.connect((input as { sessionId?: unknown }).sessionId);
    }),
  );
  register(ipcMain, DESKTOP_IPC.realtimeClose, (_event, value: unknown) =>
    result(async () => {
      await realtime.close(connectionId(value));
      return null;
    }),
  );

  register(ipcMain, DESKTOP_IPC.hostStatus, () =>
    result(() => host.getStatus(), hostRuntimeError),
  );

  register(ipcMain, DESKTOP_IPC.shellOpenExternal, (_event, value: unknown) =>
    result(async () => {
      await shell.openExternal(validatedExternalUrl(value));
      return null;
    }),
  );
  register(ipcMain, DESKTOP_IPC.shellNotify, (_event, value: unknown) =>
    result(() => {
      shell.notify(validatedNotification(value));
      return null;
    }),
  );
}

function hostRuntimeError(caught: unknown): RuntimeErrorV1 {
  const code = errorCode(caught);
  return {
    status: 0,
    code,
    message:
      code === "host_restart_required"
        ? "检测到旧版 Host 仍在运行，请先完全退出 Codex Collab 后重试。"
        : "本机 Host 当前不可用。",
  };
}

function errorCode(caught: unknown): string {
  if (!caught || typeof caught !== "object" || !("code" in caught)) {
    return "host_unavailable";
  }
  const code = (caught as { code?: unknown }).code;
  return code === "host_restart_required" || code === "request_timeout"
    ? code
    : "host_unavailable";
}
