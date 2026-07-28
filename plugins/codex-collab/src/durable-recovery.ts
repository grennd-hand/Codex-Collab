export class DurableRecoveryBlockedError extends Error {
  readonly code: string = "durable_recovery_blocked";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableRecoveryBlockedError";
  }
}

export function isDurableRecoveryBlockedError(
  error: unknown,
): error is DurableRecoveryBlockedError {
  return error instanceof DurableRecoveryBlockedError;
}
