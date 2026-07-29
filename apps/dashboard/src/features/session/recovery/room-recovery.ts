export function recoveryBundleText(sessionId: string, recoveryKey: string): string {
  return `房间 ID: ${sessionId}\n房主密钥: ${recoveryKey}`;
}
