import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RealtimeEnvelope } from "@codex-collab/protocol";
import { CodexAppServerClient } from "./app-server-client.js";
import { localProfilePath, LocalProfileStore } from "./local-profile.js";
import { RelayClient, RelayRequestError } from "./relay-client.js";
import { WorkspaceSyncService } from "./workspace-sync-service.js";

const syncIntervalMs = 1_000;
// Relay realtime events cover shared commands, but a turn started directly in
// Codex Desktop has no relay event. Poll the selected local task every second so
// short Desktop turns still publish a visible running state.
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
let reconnectAttempt = 0;
let realtimeConnecting = false;
let realtimeConnectionEpoch = 0;
let blockedRealtimeProfileKey: string | null = null;

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
  realtimeConnectionEpoch += 1;
  realtimeConnecting = false;
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

function reconnectDelay(attempt: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function scheduleRealtimeReconnect(profileKey: string): void {
  if (stopping || realtimeProfileKey !== profileKey || reconnectTimer) return;
  const delay = reconnectDelay(reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureRealtimeConnection();
  }, delay);
  reconnectTimer.unref();
}

async function ensureRealtimeConnection(): Promise<void> {
  const profile = await profiles.read();
  if (!profile || profile.role !== "owner") {
    realtimeProfileKey = null;
    blockedRealtimeProfileKey = null;
    reconnectAttempt = 0;
    closeRealtimeConnection();
    return;
  }
  const profileKey = `${profile.relayUrl}\n${profile.sessionId}\n${profile.memberToken}`;
  if (blockedRealtimeProfileKey === profileKey) return;
  if (
    realtimeProfileKey === profileKey &&
    ((realtimeSocket && realtimeSocket.readyState < WebSocket.CLOSING) ||
      realtimeConnecting ||
      reconnectTimer)
  ) {
    return;
  }
  if (realtimeProfileKey !== profileKey) {
    closeRealtimeConnection();
    reconnectAttempt = 0;
    blockedRealtimeProfileKey = null;
  }
  realtimeProfileKey = profileKey;
  const connectionEpoch = realtimeConnectionEpoch;
  realtimeConnecting = true;
  let ticket: string | null = null;
  let useLegacyRealtime = false;
  try {
    ticket = (
      await new RelayClient(profile.relayUrl).createRealtimeTicket(
        profile.sessionId,
        profile.memberToken,
      )
    ).ticket;
  } catch (error) {
    realtimeConnecting = false;
    if (connectionEpoch !== realtimeConnectionEpoch || realtimeProfileKey !== profileKey) return;
    if (error instanceof RelayRequestError && error.status === 404) {
      useLegacyRealtime = true;
    } else if (
      error instanceof RelayRequestError &&
      (error.status === 401 || error.status === 403)
    ) {
      blockedRealtimeProfileKey = profileKey;
      console.error(
        "[codex-collab realtime] Credentials were rejected; pair the host again to reconnect",
      );
      return;
    } else {
      scheduleRealtimeReconnect(profileKey);
      return;
    }
  }
  realtimeConnecting = false;
  if (connectionEpoch !== realtimeConnectionEpoch || realtimeProfileKey !== profileKey) return;
  const url = new URL("/v1/realtime", profile.relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (useLegacyRealtime) {
    url.searchParams.set("sessionId", profile.sessionId);
    url.searchParams.set("token", profile.memberToken);
  } else if (ticket) {
    url.searchParams.set("ticket", ticket);
  } else {
    scheduleRealtimeReconnect(profileKey);
    return;
  }
  const socket = new WebSocket(url);
  realtimeSocket = socket;
  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
  });
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
  socket.addEventListener("close", (event) => {
    if (realtimeSocket === socket) {
      realtimeSocket = null;
    }
    if (event.code === 4001) {
      blockedRealtimeProfileKey = profileKey;
      return;
    }
    if (!stopping && realtimeProfileKey === profileKey) {
      scheduleRealtimeReconnect(profileKey);
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
}, syncIntervalMs);
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("exit", () => {
  void releaseWorkerLock();
});

await runSync();
