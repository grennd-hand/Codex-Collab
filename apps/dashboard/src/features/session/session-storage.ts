import type { Member, Session } from "@codex-collab/protocol";

const SESSION_STORAGE_KEY = "codexCollab";

export interface SavedCredential {
  session: Session;
  member: Member;
  token: string;
}

export type SessionExitReason = "manual" | "credential-rejected";

export function loadCredential(): SavedCredential | null {
  const saved = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!saved) return null;

  try {
    const parsed = JSON.parse(saved) as SavedCredential;
    if (!parsed.session?.id || !parsed.member?.id || !parsed.token) {
      throw new Error("invalid saved session");
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

export function persistCredential(credential: SavedCredential): void {
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(credential));
}

export function clearCredential(): void {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

export function deviceLabel(): string {
  return navigator.platform || "Web device";
}

export function inviteTokenFromLocation(): string {
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  return parameters.get("invite")?.trim() ?? "";
}

export function inviteLinkForCurrentOrigin(inviteToken: string): string {
  const url = new URL("/", window.location.origin);
  url.hash = new URLSearchParams({ invite: inviteToken }).toString();
  return url.toString();
}

export function isLoopbackOrigin(): boolean {
  return (
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "::1"
  );
}
