import type { UtilityProcess } from "electron";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HostWorkerLaunchSpec } from "codex-collab/host-ipc";
import { createElectronHostWorkerLauncher } from "./electron-host-worker-launcher.js";

const workingDirectory = resolve("E:/Codex-Collab/apps/desktop");
const spec: HostWorkerLaunchSpec = {
  workerPath: resolve("E:/Codex-Collab/plugins/codex-collab/dist/workspace-sync-worker.js"),
  brokerPath: resolve("E:/Codex-Collab/native/host-ipc/target/release/codex-collab-host-ipc.exe"),
  stateDirectory: resolve("C:/Users/owner/AppData/Roaming/Codex Collab/host"),
  env: {
    SystemRoot: "C:\\Windows",
    CODEX_COLLAB_SYNC_WORKER: "1",
    CODEX_COLLAB_HOST_STATE_DIR: resolve("C:/user-data/host"),
    CODEX_COLLAB_HOST_IPC_BROKER: resolve("C:/resources/native/broker.exe"),
    CODEX_COLLAB_HOST_DESKTOP_CAPABILITY: "must-not-leak",
  },
};

function utilityProcess(): UtilityProcess & EventEmitter {
  return Object.assign(new EventEmitter(), {
    pid: undefined,
    kill: vi.fn(() => true),
    postMessage: vi.fn(),
    stdout: null,
    stderr: null,
  }) as unknown as UtilityProcess & EventEmitter;
}

describe("createElectronHostWorkerLauncher", () => {
  it("forks the shared worker and resolves after Electron reports spawn", async () => {
    const child = utilityProcess();
    const forkProcess = vi.fn(() => child);
    const launcher = createElectronHostWorkerLauncher(
      forkProcess,
      workingDirectory,
    );

    const started = launcher.spawn(spec);
    child.emit("spawn");
    await expect(started).resolves.toBeUndefined();
    expect(forkProcess).toHaveBeenCalledWith(spec.workerPath, [], {
      cwd: workingDirectory,
      env: {
        SystemRoot: "C:\\Windows",
        CODEX_COLLAB_SYNC_WORKER: "1",
        CODEX_COLLAB_HOST_STATE_DIR: spec.env.CODEX_COLLAB_HOST_STATE_DIR,
        CODEX_COLLAB_HOST_IPC_BROKER: spec.env.CODEX_COLLAB_HOST_IPC_BROKER,
      },
      execArgv: [],
      stdio: "ignore",
      serviceName: "Codex Collab Host",
    });
  });

  it("rejects an exit before spawn without launching a fallback", async () => {
    const child = utilityProcess();
    const forkProcess = vi.fn(() => child);
    const started = createElectronHostWorkerLauncher(
      forkProcess,
      workingDirectory,
    ).spawn(spec);

    child.emit("exit", 1);
    await expect(started).rejects.toThrow("desktop_host_worker_exited_before_spawn");
    expect(forkProcess).toHaveBeenCalledOnce();
  });
});
