import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  hostRuntimeLockPath,
  hostRuntimeProcessIsRunning,
  readHostRuntimeLock,
} from "./host/host-runtime-lock.js";
import {
  discardHostIpcEndpoint,
  hostIpcStateDirectory,
  readHostIpcEndpoint,
  type HostIpcClientEndpointV1,
} from "./host/ipc/endpoint.js";
import { defaultHostWorkerPath, resolveHostIpcBrokerPath } from "./host/ipc/paths.js";
import type { HostIpcClientKind } from "./host/ipc/protocol.js";
import {
  connectHostIpcClient,
  type DesktopHostIpcClient,
  type McpHostIpcClient,
} from "./host/ipc/transport.js";

export interface HostWorkerLaunchSpec {
  workerPath: string;
  brokerPath: string;
  stateDirectory: string;
  env: NodeJS.ProcessEnv;
}

export type SpawnHostWorker = (spec: HostWorkerLaunchSpec) => void | Promise<void>;

export interface ConnectHostIpcOptions {
  clientKind: HostIpcClientKind;
  workerPath?: string;
  brokerPath?: string;
  stateDirectory?: string;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  spawnWorker?: SpawnHostWorker;
  isProcessRunning?: (pid: number) => boolean;
  connectClient?: (
    endpoint: HostIpcClientEndpointV1,
  ) => Promise<McpHostIpcClient | DesktopHostIpcClient>;
}

export class HostIpcStartupError extends Error {
  constructor(
    readonly code: "host_restart_required" | "host_start_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostIpcStartupError";
  }
}

export function connectOrStartHostIpc(
  options: ConnectHostIpcOptions & { clientKind: "mcp" },
): Promise<McpHostIpcClient>;
export function connectOrStartHostIpc(
  options: ConnectHostIpcOptions & { clientKind: "desktop" },
): Promise<DesktopHostIpcClient>;
export function connectOrStartHostIpc(
  options: ConnectHostIpcOptions,
): Promise<McpHostIpcClient | DesktopHostIpcClient>;
export async function connectOrStartHostIpc(
  options: ConnectHostIpcOptions,
): Promise<McpHostIpcClient | DesktopHostIpcClient> {
  const stateDirectory = resolve(options.stateDirectory ?? hostIpcStateDirectory());
  const deadline = Date.now() + (options.startupTimeoutMs ?? 10_000);
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const isProcessRunning = options.isProcessRunning ?? hostRuntimeProcessIsRunning;
  const connectClient = options.connectClient ?? connectHostIpcClient;
  let spawned = false;
  let lastError: unknown;

  for (;;) {
    let endpoint: HostIpcClientEndpointV1 | null = null;
    try {
      endpoint = await readHostIpcEndpoint(options.clientKind, stateDirectory);
    } catch (error) {
      lastError = error;
      const lock = await readHostRuntimeLock(hostRuntimeLockPath(stateDirectory));
      if (!lock || !isProcessRunning(lock.pid)) {
        await discardHostIpcEndpoint(stateDirectory);
      }
    }

    let liveEndpoint = false;
    if (endpoint) {
      liveEndpoint = isProcessRunning(endpoint.hostPid);
      if (liveEndpoint) {
        try {
          const client = await connectClient(endpoint);
          await client.status();
          return client;
        } catch (error) {
          lastError = error;
        }
      } else {
        await discardHostIpcEndpoint(stateDirectory);
      }
    }

    const lock = await readHostRuntimeLock(hostRuntimeLockPath(stateDirectory));
    const liveLock = lock !== null && isProcessRunning(lock.pid);
    if (!liveEndpoint && !liveLock && !spawned) {
      const brokerPath = await resolveHostIpcBrokerPath(options.brokerPath);
      const workerPath = options.workerPath ?? defaultHostWorkerPath();
      const spec: HostWorkerLaunchSpec = {
        workerPath,
        brokerPath,
        stateDirectory,
        env: {
          ...process.env,
          CODEX_COLLAB_SYNC_WORKER: "1",
          CODEX_COLLAB_HOST_STATE_DIR: stateDirectory,
          CODEX_COLLAB_HOST_IPC_BROKER: brokerPath,
        },
      };
      try {
        await (options.spawnWorker ?? spawnDetachedHostWorker)(spec);
        spawned = true;
      } catch (error) {
        throw new HostIpcStartupError(
          "host_start_failed",
          "Failed to launch the Codex Collab Host",
          { cause: error },
        );
      }
    }

    if (Date.now() >= deadline) {
      const currentLock = await readHostRuntimeLock(hostRuntimeLockPath(stateDirectory));
      if (
        liveEndpoint ||
        (currentLock !== null && isProcessRunning(currentLock.pid) && !spawned)
      ) {
        throw new HostIpcStartupError(
          "host_restart_required",
          "A running Host has no usable IPC endpoint; restart Codex Collab",
          { cause: lastError },
        );
      }
      throw new HostIpcStartupError(
        "host_start_failed",
        "Timed out waiting for the Codex Collab Host",
        { cause: lastError },
      );
    }
    await wait(pollIntervalMs);
  }
}

export function ensureWorkspaceSyncWorker(
  options: Omit<ConnectHostIpcOptions, "clientKind"> = {},
): Promise<McpHostIpcClient> {
  return connectOrStartHostIpc({ ...options, clientKind: "mcp" });
}

function spawnDetachedHostWorker(spec: HostWorkerLaunchSpec): Promise<void> {
  return new Promise((resolveSpawn, reject) => {
    const child = spawn(process.execPath, [spec.workerPath], {
      detached: true,
      env: spec.env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.off("error", reject);
      child.unref();
      resolveSpawn();
    });
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}
