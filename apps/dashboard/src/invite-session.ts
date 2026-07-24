export function shouldRestoreCredential(inviteToken: string): boolean {
  return inviteToken.trim().length === 0;
}
