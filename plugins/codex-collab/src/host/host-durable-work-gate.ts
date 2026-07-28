import {
  isDurableRecoveryBlockedError,
  type DurableRecoveryBlockedError,
} from "../durable-recovery.js";

export class HostDurableWorkGate {
  private active: Promise<void> = Promise.resolve();
  private failureHandler: ((error: DurableRecoveryBlockedError) => void) | null = null;

  setFailureHandler(handler: (error: DurableRecoveryBlockedError) => void): void {
    this.failureHandler = handler;
  }

  async waitForActiveWork(): Promise<void> {
    await this.active;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.active.then(operation, operation);
    this.active = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending.catch((error: unknown) => {
      if (isDurableRecoveryBlockedError(error)) this.failureHandler?.(error);
      throw error;
    });
  }
}
