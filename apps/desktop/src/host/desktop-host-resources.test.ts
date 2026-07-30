import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDesktopHostResources,
  resolveSharedHostStateDirectory,
} from "./desktop-host-resources.js";

describe("resolveDesktopHostResources", () => {
  it("resolves packaged Host code and broker outside app.asar", () => {
    const appPath = resolve("C:/Program Files/Codex Collab/resources/app.asar");
    const resourcesPath = resolve("C:/Program Files/Codex Collab/resources");
    const hostStateDirectory = resolve("C:/Users/owner/.codex-collab");

    expect(
      resolveDesktopHostResources({
        appPath,
        resourcesPath,
        hostStateDirectory,
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
      stateDirectory: hostStateDirectory,
      workingDirectory: join(resourcesPath, "host"),
    });
  });

  it("resolves development assets from the desktop workspace", () => {
    const appPath = resolve("E:/Codex-Collab/apps/desktop");

    expect(
      resolveDesktopHostResources({
        appPath,
        resourcesPath: resolve("E:/Codex-Collab/node_modules/electron/dist/resources"),
        hostStateDirectory: resolve("C:/Users/owner/.codex-collab"),
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
        hostStateDirectory: resolve("C:/Users/owner/.codex-collab"),
        isPackaged: false,
      }),
    ).toThrow("desktop_host_appPath_must_be_absolute");
  });

  it("shares the default Host state directory with MCP clients", () => {
    expect(
      resolveSharedHostStateDirectory({}, resolve("C:/Users/owner")),
    ).toBe(resolve("C:/Users/owner/.codex-collab"));
    expect(
      resolveSharedHostStateDirectory(
        { CODEX_COLLAB_STATE_FILE: resolve("D:/profiles/owner.json") },
        resolve("C:/Users/owner"),
      ),
    ).toBe(resolve("D:/profiles"));
    expect(
      resolveSharedHostStateDirectory(
        { CODEX_COLLAB_HOST_STATE_DIR: resolve("D:/host-state") },
        resolve("C:/Users/owner"),
      ),
    ).toBe(resolve("D:/host-state"));
  });
});
