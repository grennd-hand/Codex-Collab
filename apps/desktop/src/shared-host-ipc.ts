import type {
  ConnectHostIpcOptions,
  DesktopHostIpcClient,
  SpawnHostWorker,
} from "codex-collab/host-ipc";
import { pathToFileURL } from "node:url";
import type { DesktopHostResources } from "./desktop-host-resources.js";

type DesktopHostConnector = (
  options: ConnectHostIpcOptions & { clientKind: "desktop" },
) => Promise<DesktopHostIpcClient>;

type HostIpcModuleLoader = (specifier: string) => Promise<unknown>;

const loadModule: HostIpcModuleLoader = (specifier) => import(specifier);

/** Loads only the explicitly staged shared Host client entrypoint. */
export async function connectDesktopHost(
  resources: DesktopHostResources,
  spawnWorker: SpawnHostWorker,
  moduleLoader: HostIpcModuleLoader = loadModule,
): Promise<DesktopHostIpcClient> {
  const loaded = await moduleLoader(pathToFileURL(resources.hostIpcModulePath).href);
  if (!loaded || typeof loaded !== "object") {
    throw new Error("desktop_host_ipc_module_invalid");
  }
  const connect = (loaded as { connectOrStartHostIpc?: unknown })
    .connectOrStartHostIpc;
  if (typeof connect !== "function") {
    throw new Error("desktop_host_ipc_module_invalid");
  }
  return (connect as DesktopHostConnector)({
    clientKind: "desktop",
    workerPath: resources.workerPath,
    brokerPath: resources.brokerPath,
    stateDirectory: resources.stateDirectory,
    spawnWorker,
  });
}
