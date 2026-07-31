export function shouldApplyWorkspaceResponse(
  responseSequence: number,
  lastAppliedSequence: number,
): boolean {
  return responseSequence > lastAppliedSequence;
}

export function isWorkspaceRefreshAbort(caught: unknown): boolean {
  return caught instanceof Error && caught.name === "AbortError";
}

export class TrailingHistoryRefreshLatch {
  private pending = false;

  queue(): void {
    this.pending = true;
  }

  clear(): void {
    this.pending = false;
  }

  take(): boolean {
    const pending = this.pending;
    this.pending = false;
    return pending;
  }
}
