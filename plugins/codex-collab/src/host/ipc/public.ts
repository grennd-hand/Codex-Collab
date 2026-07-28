export {
  connectOrStartHostIpc,
  ensureWorkspaceSyncWorker,
  HostIpcStartupError,
  type ConnectHostIpcOptions,
  type HostWorkerLaunchSpec,
  type SpawnHostWorker,
} from "../../workspace-sync-worker-control.js";
export type {
  DesktopHostIpcClient,
  McpHostIpcClient,
} from "./transport.js";
export type { HostIpcStatusV1 } from "./protocol.js";
