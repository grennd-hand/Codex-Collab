import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  protocol,
  safeStorage,
  session,
  Tray,
  utilityProcess,
  shell,
} from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopQuitCoordinator } from "./app-lifecycle.js";
import {
  EncryptedCredentialStore,
  type CredentialEncryption,
} from "./credential-store.js";
import { createDesktopProtocolHandler } from "./custom-protocol.js";
import { resolveDesktopConfig } from "./desktop-config.js";
import { resolveDesktopHostResources } from "./desktop-host-resources.js";
import { createElectronHostWorkerLauncher } from "./electron-host-worker-launcher.js";
import { DesktopHostLifecycleControl } from "./host-lifecycle-control.js";
import { registerDesktopIpc } from "./ipc-handlers.js";
import {
  DESKTOP_APP_URL,
  DESKTOP_IPC,
  type DesktopRealtimeEventV1,
} from "./ipc-contract.js";
import { DesktopRealtimeManager } from "./realtime-manager.js";
import { DesktopRelayTransport } from "./relay-http-client.js";
import { connectDesktopHost } from "./shared-host-ipc.js";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "codex-collab",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
      allowServiceWorkers: false,
      bypassCSP: false,
    },
  },
]);

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const rendererRoot = join(currentDirectory, "..", "renderer");
const preloadPath = join(currentDirectory, "preload.cjs");
const TRAY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJElEQVR42mNk+M9Qz0AEYBxVSFUBCjYwMDAwGkY1jGoY1TAKANsxAx3DgIsAAAAASUVORK5CYII=";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createMainWindow(quit: DesktopQuitCoordinator): BrowserWindow {
  const window = new BrowserWindow({
    width: 1_520,
    height: 940,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: "#111111",
    title: "Codex Collab",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
      spellcheck: true,
    },
  });

  window.on("close", (event) => {
    if (!quit.isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("render-process-gone", () => {
    console.error("Desktop renderer exited unexpectedly.");
  });
  void window.loadURL(DESKTOP_APP_URL);
  return window;
}

function createTray(quit: DesktopQuitCoordinator): Tray {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_PNG, "base64"));
  const nextTray = new Tray(icon.resize({ width: 16, height: 16 }));
  nextTray.setToolTip("Codex Collab");
  nextTray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示 Codex Collab", click: showMainWindow },
      { type: "separator" },
      {
        label: "退出并停止 Host",
        click: () => void quit.requestQuit(),
      },
    ]),
  );
  nextTray.on("click", showMainWindow);
  return nextTray;
}

function safeStorageEncryption(): CredentialEncryption {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plainText) => safeStorage.encryptString(plainText),
    decrypt: (cipherText) => safeStorage.decryptString(cipherText),
  };
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
  void app.whenReady().then(async () => {
    app.setAppUserModelId("io.codexcollab.owner");
    const config = resolveDesktopConfig(process.env, app.isPackaged);
    await protocol.handle(
      "codex-collab",
      createDesktopProtocolHandler(rendererRoot),
    );

    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );

    const credentials = new EncryptedCredentialStore(
      app.getPath("userData"),
      safeStorageEncryption(),
    );
    const relay = new DesktopRelayTransport(
      config.publicRelayOrigin,
      credentials,
    );
    const publishRealtime = (event: DesktopRealtimeEventV1): void => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(DESKTOP_IPC.realtimeEvent, event);
      }
    };
    const realtime = new DesktopRealtimeManager(
      config.publicRelayOrigin,
      relay,
      publishRealtime,
    );
    const hostResources = resolveDesktopHostResources({
      appPath: app.getAppPath(),
      userDataPath: app.getPath("userData"),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    });
    const workerLauncher = createElectronHostWorkerLauncher(
      (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
      hostResources.workingDirectory,
    );
    const host = new DesktopHostLifecycleControl(() =>
      connectDesktopHost(hostResources, (spec) => workerLauncher.spawn(spec)),
    );
    host.onStatus((status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(DESKTOP_IPC.hostStatusEvent, { status });
      }
    });
    const quit = new DesktopQuitCoordinator(app, realtime, credentials, host);

    registerDesktopIpc({
      app,
      ipcMain,
      relayOrigin: config.publicRelayOrigin,
      credentials,
      relay,
      realtime,
      host,
      shell: {
        openExternal: (url) => shell.openExternal(url),
        notify: (notification) => {
          if (
            mainWindow &&
            !mainWindow.isDestroyed() &&
            !mainWindow.isVisible() &&
            Notification.isSupported()
          ) {
            new Notification(notification).show();
          }
        },
      },
    });
    mainWindow = createMainWindow(quit);
    tray = createTray(quit);
    void host.start().catch(() => {
      console.error("Desktop Host failed to become ready.");
    });

    app.on("activate", showMainWindow);
    app.on("before-quit", (event) => {
      if (!quit.isQuitting) {
        event.preventDefault();
        void quit.requestQuit();
      }
    });
  });
}
