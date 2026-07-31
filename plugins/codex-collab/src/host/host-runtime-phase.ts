import type { RoomStatus } from "@codex-collab/protocol";

export type HostRuntimePhase =
  | "unpaired"
  | "active"
  | "draining"
  | "suspended"
  | "catching-up"
  | "failed";

interface HostRoomLifecycleOptions {
  waitForActiveWork(): Promise<void>;
  cancelActiveWork(): Promise<void>;
  reconcileAfterResume(): Promise<void>;
  reportError(scope: string, error: unknown): void;
  isRetryableFailure?(error: unknown): boolean;
  onFailure?(error: unknown): void | Promise<void>;
  random?: () => number;
  retryBaseMs?: number;
  onPhaseChange?: (phase: HostRuntimePhase) => void;
}

export class HostRoomLifecycle {
  private phase: HostRuntimePhase = "unpaired";
  private desiredRoomStatus: RoomStatus | null = null;
  private transition: Promise<void> = Promise.resolve();
  private transitionVersion = 0;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;

  constructor(private readonly options: HostRoomLifecycleOptions) {}

  getPhase(): HostRuntimePhase {
    return this.phase;
  }

  markUnpaired(): void {
    if (this.desiredRoomStatus === null && this.phase === "unpaired") return;
    this.transitionVersion += 1;
    this.desiredRoomStatus = null;
    this.clearRetry();
    this.setPhase("unpaired");
  }

  markFailed(error?: unknown): void {
    if (this.stopped) return;
    this.transitionVersion += 1;
    this.clearRetry();
    this.setPhase("failed");
    void this.reportFailure(error);
    if (error) this.options.reportError("[codex-collab durable recovery]", error);
  }

  applyRoomStatus(roomStatus: RoomStatus): void {
    if (this.stopped) return;
    const retryFailedOpen = roomStatus === "open" && this.phase === "failed";
    if (this.desiredRoomStatus === roomStatus && !retryFailedOpen) return;

    this.desiredRoomStatus = roomStatus;
    this.clearRetry();
    const version = ++this.transitionVersion;
    if (roomStatus === "closed") {
      if (this.phase === "active" || this.phase === "catching-up" || this.phase === "failed") {
        this.setPhase("draining");
      }
    } else if (this.phase !== "active") {
      this.setPhase("catching-up");
    }

    const cancellation = roomStatus === "closed"
      ? this.options.cancelActiveWork().then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        )
      : null;
    const pending = this.transition.then(() =>
      this.applyTransition(roomStatus, version, cancellation),
    );
    this.transition = pending.catch(async (error: unknown) => {
      if (this.phase !== "failed") {
        this.options.reportError("[codex-collab resume]", error);
      }
      if (!this.stopped && version === this.transitionVersion) {
        const retryable =
          roomStatus === "open" &&
          (this.options.isRetryableFailure?.(error) ?? false);
        this.setPhase("failed");
        await this.reportFailure(error);
        if (retryable) this.scheduleOpenRetry();
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.transitionVersion += 1;
    this.desiredRoomStatus = null;
    this.clearRetry();
    await this.options.waitForActiveWork();
    await this.transition;
  }

  private async applyTransition(
    roomStatus: RoomStatus,
    version: number,
    cancellation: Promise<{ error: unknown }> | null,
  ): Promise<void> {
    if (this.stopped || version !== this.transitionVersion) return;
    if (roomStatus === "closed") {
      await this.options.waitForActiveWork();
      if (this.stopped || version !== this.transitionVersion) return;
      const cancelled = await cancellation!;
      if (cancelled.error) throw cancelled.error;
      this.setPhase("suspended");
      return;
    }
    await this.options.waitForActiveWork();
    if (this.stopped || version !== this.transitionVersion) return;
    this.setPhase("catching-up");
    await this.options.reconcileAfterResume();
    if (!this.stopped && version === this.transitionVersion) this.setPhase("active");
  }

  private setPhase(phase: HostRuntimePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    if (phase === "active") {
      this.clearRetry();
      this.retryAttempt = 0;
    }
    try {
      this.options.onPhaseChange?.(phase);
    } catch (error) {
      this.options.reportError("[codex-collab runtime phase]", error);
    }
  }

  private scheduleOpenRetry(): void {
    if (this.stopped || this.retryTimer || this.desiredRoomStatus !== "open") return;
    const base = this.options.retryBaseMs ?? 1_000;
    const delay = Math.min(30_000, base * 2 ** Math.min(this.retryAttempt, 5));
    const jittered = Math.round(delay * (0.8 + (this.options.random?.() ?? Math.random()) * 0.4));
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped && this.phase === "failed" && this.desiredRoomStatus === "open") {
        this.applyRoomStatus("open");
      }
    }, jittered);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async reportFailure(error: unknown): Promise<void> {
    try {
      await this.options.onFailure?.(error);
    } catch (statusError) {
      this.options.reportError("[codex-collab runtime status]", statusError);
    }
  }
}
