import type { DesktopHostIpcClient } from "codex-collab/host-ipc";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { DesktopHostResources } from "./desktop-host-resources.js";
import { connectDesktopHost } from "./shared-host-ipc.js";

const resources: DesktopHostResources = {
  workerPath: "E:\\app\\host\\dist\\workspace-sync-worker.js",
  hostIpcModulePath: "E:\\app\\host\\dist\\host\\ipc\\public.js",
  brokerPath: "E:\\app\\native\\codex-collab-host-ipc.exe",
  stateDirectory: "C:\\Users\\owner\\AppData\\Roaming\\Codex Collab\\host",
  workingDirectory: "E:\\app\\host",
};

describe("connectDesktopHost", () => {
  it("loads the fixed module path and delegates connect-first with Desktop scope", async () => {
    const client = { close: vi.fn() } as unknown as DesktopHostIpcClient;
    const connectOrStartHostIpc = vi.fn(async () => client);
    const loader = vi.fn(async () => ({ connectOrStartHostIpc }));
    const spawnWorker = vi.fn();

    await expect(
      connectDesktopHost(resources, spawnWorker, loader),
    ).resolves.toBe(client);
    expect(loader).toHaveBeenCalledWith(
      pathToFileURL(resources.hostIpcModulePath).href,
    );
    expect(connectOrStartHostIpc).toHaveBeenCalledWith({
      clientKind: "desktop",
      workerPath: resources.workerPath,
      brokerPath: resources.brokerPath,
      stateDirectory: resources.stateDirectory,
      spawnWorker,
    });
  });

  it("fails closed when the staged module lacks the narrow connector", async () => {
    await expect(
      connectDesktopHost(resources, vi.fn(), async () => ({})),
    ).rejects.toThrow("desktop_host_ipc_module_invalid");
  });
});
