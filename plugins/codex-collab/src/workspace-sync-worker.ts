import { HostService, HostServiceStartupError } from "./host/host-service.js";
import { hostIpcStateDirectory } from "./host/ipc/endpoint.js";
import { resolveHostIpcBrokerPath } from "./host/ipc/paths.js";

let service: HostService | undefined;

async function stop(): Promise<void> {
  await service?.stop();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

try {
  service = await HostService.start({
    brokerPath: await resolveHostIpcBrokerPath(),
    stateDirectory: hostIpcStateDirectory(),
  });
  await service.waitUntilStopped();
} catch (error) {
  if (error instanceof HostServiceStartupError) {
    console.error(`[codex-collab host] ${error.code}: ${error.message}`);
    process.exitCode = 42;
  } else {
    console.error(
      "[codex-collab host]",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
  await stop();
}
