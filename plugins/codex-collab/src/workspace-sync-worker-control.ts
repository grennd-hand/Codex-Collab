import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function ensureWorkspaceSyncWorker(): void {
  if (process.env.CODEX_COLLAB_SYNC_WORKER === "1") {
    return;
  }
  const workerPath = fileURLToPath(new URL("./workspace-sync-worker.js", import.meta.url));
  const child = spawn(process.execPath, [workerPath], {
    detached: true,
    env: {
      ...process.env,
      CODEX_COLLAB_SYNC_WORKER: "1",
    },
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
