import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const brokerName = "codex-collab-host-ipc.exe";

export function defaultHostWorkerPath(): string {
  return fileURLToPath(new URL("../../workspace-sync-worker.js", import.meta.url));
}

export async function resolveHostIpcBrokerPath(explicitPath?: string): Promise<string> {
  if (explicitPath) return explicitPath;
  if (process.env.CODEX_COLLAB_HOST_IPC_BROKER) {
    return process.env.CODEX_COLLAB_HOST_IPC_BROKER;
  }
  const candidates = [
    new URL(`../../native/${brokerName}`, import.meta.url),
    new URL(`../../../../../native/host-ipc/target/release/${brokerName}`, import.meta.url),
    new URL(`../../../../../native/host-ipc/target/debug/${brokerName}`, import.meta.url),
  ].map((url) => fileURLToPath(url));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next development or packaged location.
    }
  }
  throw new Error(
    "Codex Collab Host IPC broker was not found; build native/host-ipc or provide brokerPath",
  );
}
