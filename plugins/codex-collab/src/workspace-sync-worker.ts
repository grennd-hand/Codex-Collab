import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RealtimeEnvelope } from "@codex-collab/protocol";
import { CodexAppServerClient } from "./app-server-client.js";
import { localProfilePath, LocalProfileStore } from "./local-profile.js";
import { WorkspaceSyncService } from "./workspace-sync-service.js";

const intervalMs = 1_000;
const lockPath = join(dirname(localProfilePath()), "sync-worker.json");

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireWorkerLock(): Promise<boolean> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await handle.close();
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
          processIsRunning(existing.pid)
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

async function releaseWorkerLock(): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    if (existing.pid === process.pid) {
      await unlink(lockPath);
    }
  } catch {
    // The lock may already be gone during shutdown.
  }
}

if (!(await acquireWorkerLock())) {
  process.exit(0);
}

const codex = new CodexAppServerClient();
const profiles = new LocalProfileStore();
const sync = new WorkspaceSyncService(profiles, codex);
let stopping = false;
let syncRunning = false;
let syncRequested = false;
let realtimeSocket: WebSocket | null = null;
let realtimeProfileKey: string | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

async function runSync(): Promise<void> {
  if (stopping) return;
  if (syncRunning) {
    syncRequested = true;
    return;
  }
  syncRunning = true;
  do {
    syncRequested = false;
    try {
      await sync.sync();
      await ensureRealtimeConnection();
    } catch (error) {
      console.error(
        "[codex-collab workspace]",
        error instanceof Error ? error.message : String(error),
      );
    }
  } while (syncRequested && !stopping);
  syncRunning = false;
}

async function forwardRealtimeCommand(): Promise<void> {
  if (stopping) return;
  try {
    await sync.forwardPendingCommand();
  } catch (error) {
    console.error(
      "[codex-collab command]",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    void runSync();
  }
}

function closeRealtimeConnection(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const socket = realtimeSocket;
  realtimeSocket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) {
    try {
      socket.close();
    } catch {
      // A connecting socket can close itself after the failed handshake.
    }
  }
}

async function ensureRealtimeConnection(): Promise<void> {
  const profile = await profiles.read();
  if (!profile || profile.role !== "owner") {
    realtimeProfileKey = null;
    closeRealtimeConnection();
    return;
  }
  const profileKey = `${profile.relayUrl}\n${profile.sessionId}`;
  if (
    realtimeProfileKey === profileKey &&
    realtimeSocket &&
    realtimeSocket.readyState < WebSocket.CLOSING
  ) {
    return;
  }
  closeRealtimeConnection();
  realtimeProfileKey = profileKey;
  const url = new URL("/v1/realtime", profile.relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("sessionId", profile.sessionId);
  url.searchParams.set("token", profile.memberToken);
  const socket = new WebSocket(url);
  realtimeSocket = socket;
  socket.addEventListener("message", (event) => {
    try {
      const envelope = JSON.parse(String(event.data)) as RealtimeEnvelope;
      if (
        envelope.sessionId === profile.sessionId &&
        envelope.type === "message.created"
      ) {
        void forwardRealtimeCommand();
      }
    } catch {
      // Ignore malformed realtime payloads and retain polling as fallback.
    }
  });
  socket.addEventListener("close", () => {
    if (realtimeSocket === socket) {
      realtimeSocket = null;
    }
    if (!stopping && realtimeProfileKey === profileKey) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void ensureRealtimeConnection();
      }, 1_500);
      reconnectTimer.unref();
    }
  });
  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      // The close event or polling fallback will reconnect.
    }
  });
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  closeRealtimeConnection();
  await codex.close();
  await releaseWorkerLock();
  process.exit(0);
}

const timer = setInterval(() => {
  void runSync();
}, intervalMs);
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("exit", () => {
  void releaseWorkerLock();
});

await runSync();
