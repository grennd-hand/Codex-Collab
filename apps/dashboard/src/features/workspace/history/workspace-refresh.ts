export function shouldApplyWorkspaceResponse(
  responseSequence: number,
  lastAppliedSequence: number,
): boolean {
  return responseSequence > lastAppliedSequence;
}

export function isWorkspaceRefreshAbort(caught: unknown): boolean {
  return caught instanceof Error && caught.name === "AbortError";
}
