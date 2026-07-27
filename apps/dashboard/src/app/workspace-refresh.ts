export function shouldApplyWorkspaceResponse(
  responseSequence: number,
  lastAppliedSequence: number,
): boolean {
  return responseSequence > lastAppliedSequence;
}
