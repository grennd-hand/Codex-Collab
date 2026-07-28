import type { RealtimeEnvelope } from "@codex-collab/protocol";
import type { LocalProfile } from "../local-profile.js";
import { RelayClient, RelayRequestError } from "../relay-client.js";
import { HostRoomLifecycle, type HostRuntimePhase } from "./host-runtime-phase.js";
import { withHostRuntimeTimeout } from "./host-runtime-timeout.js";

export type { HostRuntimePhase } from "./host-runtime-phase.js";
const defaultSyncIntervalMs = 1_000;

interface RealtimeSocket {
  readonly readyState: number;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  close(): void;
}

interface RealtimeTicketClient {
  createRealtimeTicket(sessionId: string, memberToken: string): Promise<{ ticket: string }>;
}
export interface HostRuntimeOptions {
  application: HostRuntimeApplication;
  syncIntervalMs?: number;
  createRelayClient?: (relayUrl: string) => RealtimeTicketClient;
  createRealtimeSocket?: (url: URL) => RealtimeSocket;
  random?: () => number;
  reportError?: (scope: string, error: unknown) => void;
  onPhaseChange?: (phase: HostRuntimePhase) => void;
  cancelTimeoutMs?: number;
}

export interface HostRuntimeApplication {
  readRuntimeProfile(): Promise<LocalProfile | null>;
  runBackgroundCycle(): Promise<void>;
  reconcileAfterResume?(): Promise<void>;
  cancelActiveWork?(): Promise<void>;
  forwardPendingCommand(): Promise<string | null>;
  close(): Promise<void>;
}

function profileKey(profile: LocalProfile): string {
  return `${profile.relayUrl}\n${profile.sessionId}\n${profile.memberToken}`;
}

function defaultReportError(scope: string, error: unknown): void {
  console.error(scope, error instanceof Error ? error.message : String(error));
}

export class HostRuntime {
  private readonly syncIntervalMs: number;
  private readonly createRelayClient: (relayUrl: string) => RealtimeTicketClient;
  private readonly createRealtimeSocket: (url: URL) => RealtimeSocket;
  private readonly random: () => number;
  private readonly reportError: (scope: string, error: unknown) => void;
  private readonly roomLifecycle: HostRoomLifecycle;
  private stopping = false;
  private activeSync: Promise<void> | null = null;
  private activeForward: Promise<void> | null = null;
  private syncRequested = false;
  private realtimeSocket: RealtimeSocket | null = null;
  private realtimeProfileKey: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private realtimeConnecting = false;
  private realtimeConnectionEpoch = 0;
  private blockedRealtimeProfileKey: string | null = null;
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: HostRuntimeOptions) {
    this.syncIntervalMs = options.syncIntervalMs ?? defaultSyncIntervalMs;
    this.createRelayClient = options.createRelayClient ?? ((relayUrl) => new RelayClient(relayUrl));
    this.createRealtimeSocket =
      options.createRealtimeSocket ?? ((url) => new WebSocket(url));
    this.random = options.random ?? Math.random;
    this.reportError = options.reportError ?? defaultReportError;
    const cancelTimeoutMs = options.cancelTimeoutMs ?? 10_000;
    this.roomLifecycle = new HostRoomLifecycle({
      waitForActiveWork: () => this.waitForActiveWork(),
      cancelActiveWork: () => options.application.cancelActiveWork
        ? withHostRuntimeTimeout(
            options.application.cancelActiveWork(), cancelTimeoutMs,
            "Timed out cancelling the active Codex turn",
          )
        : Promise.resolve(),
      reconcileAfterResume: () => this.runResumeReconciliation(),
      reportError: this.reportError,
      ...(options.onPhaseChange ? { onPhaseChange: options.onPhaseChange } : {}),
    });
  }

  getPhase(): HostRuntimePhase {
    return this.roomLifecycle.getPhase();
  }

  async start(): Promise<void> {
    if (this.syncTimer || this.stopping) return;
    this.syncTimer = setInterval(() => void this.runTick(), this.syncIntervalMs);
    await this.runTick();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.syncRequested = false;
    this.closeRealtimeConnection();
    await this.roomLifecycle.stop();
    await this.options.application.close();
  }

  private async runTick(): Promise<void> {
    if (this.stopping) return;
    try {
      await this.ensureRealtimeConnection();
      if (this.getPhase() === "active") await this.runSync();
    } catch (error) {
      this.reportError("[codex-collab workspace]", error);
    }
  }

  private runSync(queueIfRunning = false): Promise<void> {
    if (this.stopping || this.getPhase() !== "active") return Promise.resolve();
    if (this.activeSync) {
      if (queueIfRunning) this.syncRequested = true;
      return this.activeSync;
    }
    const pending = this.runSyncLoop();
    this.activeSync = pending;
    void pending.finally(() => {
      if (this.activeSync === pending) this.activeSync = null;
    });
    return pending;
  }

  private async runSyncLoop(): Promise<void> {
    do {
      this.syncRequested = false;
      try {
        await this.options.application.runBackgroundCycle();
      } catch (error) {
        this.reportError("[codex-collab workspace]", error);
      }
    } while (this.syncRequested && !this.stopping && this.getPhase() === "active");
  }

  private forwardRealtimeCommand(): Promise<void> {
    if (this.stopping || this.getPhase() !== "active") return Promise.resolve();
    if (this.activeForward) return this.activeForward;
    const pending = (async () => {
      try {
        await this.options.application.forwardPendingCommand();
      } catch (error) {
        this.reportError("[codex-collab command]", error);
      } finally {
        void this.runSync(true);
      }
    })();
    this.activeForward = pending;
    void pending.finally(() => {
      if (this.activeForward === pending) this.activeForward = null;
    });
    return pending;
  }

  private async waitForActiveWork(): Promise<void> {
    const work = [this.activeSync, this.activeForward].filter(
      (pending): pending is Promise<void> => pending !== null,
    );
    await Promise.all(work);
  }

  private async runResumeReconciliation(): Promise<void> {
    const pending = this.options.application.reconcileAfterResume
      ? this.options.application.reconcileAfterResume()
      : this.options.application.runBackgroundCycle();
    this.activeSync = pending;
    try {
      await pending;
    } finally {
      if (this.activeSync === pending) this.activeSync = null;
    }
  }

  private closeRealtimeConnection(): void {
    this.realtimeConnectionEpoch += 1;
    this.realtimeConnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.realtimeSocket;
    this.realtimeSocket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      try {
        socket.close();
      } catch {
        // A connecting socket can close itself after the failed handshake.
      }
    }
  }

  private reconnectDelay(attempt: number): number {
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    return Math.round(base * (0.8 + this.random() * 0.4));
  }

  private scheduleRealtimeReconnect(key: string): void {
    if (this.stopping || this.realtimeProfileKey !== key || this.reconnectTimer) return;
    const delay = this.reconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureRealtimeConnection();
    }, delay);
    this.reconnectTimer.unref();
  }

  private async ensureRealtimeConnection(): Promise<void> {
    const profile = await this.options.application.readRuntimeProfile();
    if (!profile || profile.role !== "owner") {
      this.syncRequested = false;
      this.roomLifecycle.markUnpaired();
      this.realtimeProfileKey = null;
      this.blockedRealtimeProfileKey = null;
      this.reconnectAttempt = 0;
      this.closeRealtimeConnection();
      return;
    }
    const key = profileKey(profile);
    if (this.blockedRealtimeProfileKey === key) return;
    if (
      this.realtimeProfileKey === key &&
      ((this.realtimeSocket && this.realtimeSocket.readyState < WebSocket.CLOSING) ||
        this.realtimeConnecting ||
        this.reconnectTimer)
    ) {
      return;
    }
    if (this.realtimeProfileKey !== key) {
      this.syncRequested = false;
      this.roomLifecycle.markUnpaired();
      this.closeRealtimeConnection();
      this.reconnectAttempt = 0;
      this.blockedRealtimeProfileKey = null;
    }
    this.realtimeProfileKey = key;
    const connectionEpoch = this.realtimeConnectionEpoch;
    this.realtimeConnecting = true;
    let ticket: string | null = null;
    let useLegacyRealtime = false;
    try {
      ticket = (
        await this.createRelayClient(profile.relayUrl).createRealtimeTicket(
          profile.sessionId,
          profile.memberToken,
        )
      ).ticket;
    } catch (error) {
      this.realtimeConnecting = false;
      if (connectionEpoch !== this.realtimeConnectionEpoch || this.realtimeProfileKey !== key) {
        return;
      }
      if (error instanceof RelayRequestError && error.status === 404) {
        useLegacyRealtime = true;
      } else if (
        error instanceof RelayRequestError &&
        (error.status === 401 || error.status === 403)
      ) {
        this.blockedRealtimeProfileKey = key;
        this.reportError(
          "[codex-collab realtime]",
          new Error("Credentials were rejected; pair the host again to reconnect"),
        );
        return;
      } else {
        this.scheduleRealtimeReconnect(key);
        return;
      }
    }
    this.realtimeConnecting = false;
    if (connectionEpoch !== this.realtimeConnectionEpoch || this.realtimeProfileKey !== key) return;
    const url = new URL("/v1/realtime", profile.relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (useLegacyRealtime) {
      url.searchParams.set("sessionId", profile.sessionId);
      url.searchParams.set("token", profile.memberToken);
    } else if (ticket) {
      url.searchParams.set("ticket", ticket);
    } else {
      this.scheduleRealtimeReconnect(key);
      return;
    }
    const socket = this.createRealtimeSocket(url);
    this.realtimeSocket = socket;
    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
    });
    socket.addEventListener("message", (event) => {
      if (this.realtimeSocket !== socket) return;
      this.handleRealtimeMessage(profile.sessionId, event.data);
    });
    socket.addEventListener("close", (event) => {
      if (this.realtimeSocket === socket) this.realtimeSocket = null;
      if (event.code === 4001) {
        this.blockedRealtimeProfileKey = key;
        return;
      }
      if (!this.stopping && this.realtimeProfileKey === key) {
        this.scheduleRealtimeReconnect(key);
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

  private handleRealtimeMessage(sessionId: string, data: unknown): void {
    try {
      const envelope = JSON.parse(String(data)) as RealtimeEnvelope;
      if (envelope.sessionId !== sessionId) return;
      if (envelope.type === "ready") {
        const payload = envelope.payload as { session?: { roomStatus?: unknown } };
        if (payload.session?.roomStatus === "open" || payload.session?.roomStatus === "closed") {
          if (payload.session.roomStatus === "closed") this.syncRequested = false;
          this.roomLifecycle.applyRoomStatus(payload.session.roomStatus);
        }
      } else if (envelope.type === "session.updated") {
        const payload = envelope.payload as { roomStatus?: unknown };
        if (payload.roomStatus === "open" || payload.roomStatus === "closed") {
          if (payload.roomStatus === "closed") this.syncRequested = false;
          this.roomLifecycle.applyRoomStatus(payload.roomStatus);
        }
      } else if (envelope.type === "message.created" && this.getPhase() === "active") {
        void this.forwardRealtimeCommand();
      } else if (envelope.type === "file.operation.updated" && this.getPhase() === "active") {
        void this.runSync(true);
      }
    } catch {
      // Ignore malformed realtime payloads and retain polling as fallback.
    }
  }
}
