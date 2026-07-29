import { contextBridge, ipcRenderer } from "electron";
import type {
  CodexCollabDesktopApiV1,
  CredentialSnapshotV1,
  DesktopHostStatusEventV1,
  DesktopRealtimeEventV1,
  DesktopRelayOperationV1,
} from "./ipc/ipc-contract.js";

const channels = Object.freeze({
  runtimeInfo: "codex-collab:runtime-info",
  credentialLoad: "codex-collab:credential-load",
  credentialUpdateSnapshot: "codex-collab:credential-update-snapshot",
  credentialClear: "codex-collab:credential-clear",
  relayPerform: "codex-collab:relay-perform",
  relayDownloadAttachment: "codex-collab:relay-download-attachment",
  realtimeConnect: "codex-collab:realtime-connect",
  realtimeClose: "codex-collab:realtime-close",
  realtimeEvent: "codex-collab:realtime-event",
  hostStatus: "codex-collab:host-status",
  hostStatusEvent: "codex-collab:host-status-event",
  shellOpenExternal: "codex-collab:shell-open-external",
  shellNotify: "codex-collab:shell-notify",
});

const api: CodexCollabDesktopApiV1 = Object.freeze({
  version: 1,
  getRuntimeInfo: () => ipcRenderer.invoke(channels.runtimeInfo),
  relay: Object.freeze({
    perform: (operation: DesktopRelayOperationV1) =>
      ipcRenderer.invoke(channels.relayPerform, operation),
    downloadMessageAttachment: (input: {
      sessionId: string;
      messageId: string;
      attachmentId: string;
    }) => ipcRenderer.invoke(channels.relayDownloadAttachment, input),
  }),
  realtime: Object.freeze({
    connect: (input: { sessionId: string }) =>
      ipcRenderer.invoke(channels.realtimeConnect, input),
    close: (connectionId: string) =>
      ipcRenderer.invoke(channels.realtimeClose, connectionId),
    onEvent: (listener: (event: DesktopRealtimeEventV1) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (payload && typeof payload === "object") {
          listener(payload as DesktopRealtimeEventV1);
        }
      };
      ipcRenderer.on(channels.realtimeEvent, handler);
      return () => ipcRenderer.removeListener(channels.realtimeEvent, handler);
    },
  }),
  credentials: Object.freeze({
    load: () => ipcRenderer.invoke(channels.credentialLoad),
    updateSnapshot: (snapshot: CredentialSnapshotV1) =>
      ipcRenderer.invoke(channels.credentialUpdateSnapshot, snapshot),
    clear: () => ipcRenderer.invoke(channels.credentialClear),
  }),
  host: Object.freeze({
    getStatus: () => ipcRenderer.invoke(channels.hostStatus),
    onStatus: (listener: (event: DesktopHostStatusEventV1) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (payload && typeof payload === "object") {
          listener(payload as DesktopHostStatusEventV1);
        }
      };
      ipcRenderer.on(channels.hostStatusEvent, handler);
      return () => ipcRenderer.removeListener(channels.hostStatusEvent, handler);
    },
  }),
  shell: Object.freeze({
    openExternal: (url: string) =>
      ipcRenderer.invoke(channels.shellOpenExternal, url),
    notify: (notification: { title: string; body: string }) =>
      ipcRenderer.invoke(channels.shellNotify, notification),
  }),
});

contextBridge.exposeInMainWorld("codexCollabDesktop", api);
