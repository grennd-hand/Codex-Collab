import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { localProfilePath } from "../persistence/local-profile.js";

export interface HostRuntimeLockInfo {
  pid: number;
  startedAt?: string;
}

export function hostRuntimeLockPath(
  stateDirectory = process.env.CODEX_COLLAB_HOST_STATE_DIR ?? dirname(localProfilePath()),
): string {
  return join(stateDirectory, "sync-worker.json");
}

export function hostRuntimeProcessIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireHostRuntimeLock(
  lockPath = hostRuntimeLockPath(),
  pid = process.pid,
  isProcessRunning: (candidatePid: number) => boolean = hostRuntimeProcessIsRunning,
): Promise<boolean> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`,
          "utf8",
        );
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const existing = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
        if (
          typeof existing.pid === "number" &&
          Number.isInteger(existing.pid) &&
          isProcessRunning(existing.pid)
        ) {
          return false;
        }
      } catch {
        // A malformed or stale lock is replaced below.
      }
      await unlink(lockPath).catch(() => undefined);
    }
  }
  return false;
}

export async function readHostRuntimeLock(
  lockPath = hostRuntimeLockPath(),
): Promise<HostRuntimeLockInfo | null> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: unknown;
      startedAt?: unknown;
    };
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return null;
    return {
      pid: value.pid as number,
      ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    };
  } catch {
    return null;
  }
}

export async function releaseHostRuntimeLock(
  lockPath = hostRuntimeLockPath(),
  pid = process.pid,
): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    if (existing.pid === pid) {
      await unlink(lockPath);
    }
  } catch {
    // The lock may already be gone during shutdown.
  }
}
