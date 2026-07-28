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
  onPhaseChange?: (phase: HostRuntimePhase) => void;
}

export class HostRoomLifecycle {
  private phase: HostRuntimePhase = "unpaired";
  private desiredRoomStatus: RoomStatus | null = null;
  private transition: Promise<void> = Promise.resolve();
  private transitionVersion = 0;
  private stopped = false;

  constructor(private readonly options: HostRoomLifecycleOptions) {}

  getPhase(): HostRuntimePhase {
    return this.phase;
  }

  markUnpaired(): void {
    if (this.desiredRoomStatus === null && this.phase === "unpaired") return;
    this.transitionVersion += 1;
    this.desiredRoomStatus = null;
    this.setPhase("unpaired");
  }

  markFailed(error?: unknown): void {
    if (this.stopped || this.phase === "failed") return;
    this.transitionVersion += 1;
    this.setPhase("failed");
    if (error) this.options.reportError("[codex-collab durable recovery]", error);
  }

  applyRoomStatus(roomStatus: RoomStatus): void {
    if (this.stopped) return;
    const retryFailedOpen = roomStatus === "open" && this.phase === "failed";
    if (this.desiredRoomStatus === roomStatus && !retryFailedOpen) return;

    this.desiredRoomStatus = roomStatus;
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
    this.transition = pending.catch((error: unknown) => {
      if (this.phase !== "failed") {
        this.options.reportError("[codex-collab resume]", error);
      }
      if (!this.stopped && version === this.transitionVersion) {
        this.setPhase("failed");
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.transitionVersion += 1;
    this.desiredRoomStatus = null;
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
    try {
      this.options.onPhaseChange?.(phase);
    } catch (error) {
      this.options.reportError("[codex-collab runtime phase]", error);
    }
  }
}
