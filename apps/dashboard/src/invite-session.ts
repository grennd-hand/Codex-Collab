export type SetupSubmissionMode = "create" | "join";

export function setupSubmissionMode(inviteToken: string): SetupSubmissionMode {
  return inviteToken.trim().length > 0 ? "join" : "create";
}

export function shouldRestoreCredential(inviteToken: string): boolean {
  return setupSubmissionMode(inviteToken) === "create";
}
