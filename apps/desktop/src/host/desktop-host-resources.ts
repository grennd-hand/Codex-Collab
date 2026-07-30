import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const HOST_WORKER_RELATIVE_PATH = join("dist", "workspace-sync-worker.js");
const HOST_IPC_MODULE_RELATIVE_PATH = join("dist", "host", "ipc", "public.js");
const PACKAGED_BROKER_RELATIVE_PATH = join(
  "native",
  "codex-collab-host-ipc.exe",
);
const DEVELOPMENT_BROKER_RELATIVE_PATH = join(
  "..",
  "..",
  "native",
  "host-ipc",
  "target",
  "release",
  "codex-collab-host-ipc.exe",
);

export interface DesktopHostPathInputs {
  appPath: string;
  hostStateDirectory: string;
  resourcesPath: string;
  isPackaged: boolean;
}

export interface DesktopHostResources {
  workerPath: string;
  hostIpcModulePath: string;
  brokerPath: string;
  stateDirectory: string;
  workingDirectory: string;
}

/**
 * Resolves the two executable assets without probing or creating filesystem
 * state. Packaged Host code and its native broker are staged as explicit
 * extraResources so electron-builder never traverses the plugin workspace.
 */
export function resolveDesktopHostResources(
  inputs: DesktopHostPathInputs,
): DesktopHostResources {
  assertAbsolutePath(inputs.appPath, "appPath");
  assertAbsolutePath(inputs.hostStateDirectory, "hostStateDirectory");
  assertAbsolutePath(inputs.resourcesPath, "resourcesPath");

  const hostRoot = inputs.isPackaged
    ? join(inputs.resourcesPath, "host")
    : resolve(inputs.appPath, "..", "..", "plugins", "codex-collab");
  const workerPath = join(hostRoot, HOST_WORKER_RELATIVE_PATH);
  const brokerPath = inputs.isPackaged
    ? join(inputs.resourcesPath, PACKAGED_BROKER_RELATIVE_PATH)
    : resolve(inputs.appPath, DEVELOPMENT_BROKER_RELATIVE_PATH);

  return {
    workerPath,
    hostIpcModulePath: join(hostRoot, HOST_IPC_MODULE_RELATIVE_PATH),
    brokerPath,
    stateDirectory: resolve(inputs.hostStateDirectory),
    workingDirectory: hostRoot,
  };
}

export function resolveSharedHostStateDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const profilePath = resolve(
    environment.CODEX_COLLAB_STATE_FILE ??
      join(homeDirectory, ".codex-collab", "state.json"),
  );
  return resolve(
    environment.CODEX_COLLAB_HOST_STATE_DIR ?? dirname(profilePath),
  );
}

function assertAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value)) {
    throw new Error(`desktop_host_${label}_must_be_absolute`);
  }
}
