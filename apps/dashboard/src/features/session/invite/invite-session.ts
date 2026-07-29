export type SetupSubmissionMode = "create" | "join" | "recover";

export function setupSubmissionMode(
  inviteToken: string,
  selectedMode: SetupSubmissionMode = "create",
): SetupSubmissionMode {
  return inviteToken.trim().length > 0 ? "join" : selectedMode;
}

export function shouldRestoreCredential(inviteToken: string): boolean {
  return setupSubmissionMode(inviteToken) === "create";
}
