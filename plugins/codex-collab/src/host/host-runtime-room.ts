import { isDurableRecoveryBlockedError } from "../persistence/durable-recovery.js";
import type { HostRuntimeOptions } from "./host-runtime-options.js";
import { HostRoomLifecycle } from "./host-runtime-phase.js";
import { withHostRuntimeTimeout } from "./host-runtime-timeout.js";

interface HostRuntimeRoomDependencies {
  waitForActiveWork(): Promise<void>;
  reconcileAfterResume(): Promise<void>;
  reportError(scope: string, error: unknown): void;
  random(): number;
}

export function createHostRuntimeRoom(
  options: HostRuntimeOptions,
  dependencies: HostRuntimeRoomDependencies,
): HostRoomLifecycle {
  const cancelTimeoutMs = options.cancelTimeoutMs ?? 10_000;
  const room = new HostRoomLifecycle({
    waitForActiveWork: dependencies.waitForActiveWork,
    cancelActiveWork: () => options.application.cancelActiveWork
      ? withHostRuntimeTimeout(
          options.application.cancelActiveWork(), cancelTimeoutMs,
          "Timed out cancelling the active Codex turn",
        )
      : Promise.resolve(),
    reconcileAfterResume: dependencies.reconcileAfterResume,
    reportError: dependencies.reportError,
    isRetryableFailure: (error) => !isDurableRecoveryBlockedError(error),
    onFailure: () => options.application.publishRuntimeUnavailable?.(),
    random: dependencies.random,
    ...(options.catchUpRetryBaseMs !== undefined
      ? { retryBaseMs: options.catchUpRetryBaseMs }
      : {}),
    ...(options.onPhaseChange ? { onPhaseChange: options.onPhaseChange } : {}),
  });
  options.application.setDurableFailureHandler?.((error) => room.markFailed(error));
  return room;
}
