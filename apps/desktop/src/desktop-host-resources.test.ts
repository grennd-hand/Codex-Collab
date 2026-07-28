import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDesktopHostResources } from "./desktop-host-resources.js";

describe("resolveDesktopHostResources", () => {
  it("resolves packaged Host code and broker outside app.asar", () => {
    const appPath = resolve("C:/Program Files/Codex Collab/resources/app.asar");
    const resourcesPath = resolve("C:/Program Files/Codex Collab/resources");
    const userDataPath = resolve("C:/Users/owner/AppData/Roaming/Codex Collab");

    expect(
      resolveDesktopHostResources({
        appPath,
        resourcesPath,
        userDataPath,
        isPackaged: true,
      }),
    ).toEqual({
      workerPath: join(resourcesPath, "host", "dist", "workspace-sync-worker.js"),
      hostIpcModulePath: join(
        resourcesPath,
        "host",
        "dist",
        "host",
        "ipc",
        "public.js",
      ),
      brokerPath: join(resourcesPath, "native", "codex-collab-host-ipc.exe"),
      stateDirectory: join(userDataPath, "host"),
      workingDirectory: join(resourcesPath, "host"),
    });
  });

  it("resolves development assets from the desktop workspace", () => {
    const appPath = resolve("E:/Codex-Collab/apps/desktop");

    expect(
      resolveDesktopHostResources({
        appPath,
        resourcesPath: resolve("E:/Codex-Collab/node_modules/electron/dist/resources"),
        userDataPath: resolve("C:/Temp/codex-collab-desktop"),
        isPackaged: false,
      }),
    ).toMatchObject({
      workerPath: resolve(
        "E:/Codex-Collab/plugins/codex-collab/dist/workspace-sync-worker.js",
      ),
      hostIpcModulePath: resolve(
        "E:/Codex-Collab/plugins/codex-collab/dist/host/ipc/public.js",
      ),
      brokerPath: resolve(
        "E:/Codex-Collab/native/host-ipc/target/release/codex-collab-host-ipc.exe",
      ),
    });
  });

  it("rejects relative roots", () => {
    expect(() =>
      resolveDesktopHostResources({
        appPath: "apps/desktop",
        resourcesPath: resolve("C:/resources"),
        userDataPath: resolve("C:/user-data"),
        isPackaged: false,
      }),
    ).toThrow("desktop_host_appPath_must_be_absolute");
  });
});
