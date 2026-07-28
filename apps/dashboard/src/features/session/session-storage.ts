import type { Member, Session } from "@codex-collab/protocol";
import {
  getDashboardRuntime,
  type DashboardCredentialV1,
  type DashboardRuntimeV1,
} from "../../shared/runtime/index.js";

export type SavedCredential = DashboardCredentialV1;
export type SessionExitReason = "manual" | "credential-rejected";

export async function loadCredential(): Promise<SavedCredential | null> {
  return getDashboardRuntime().credentials.load();
}

export async function persistCredential(
  credential: SavedCredential,
): Promise<void> {
  await getDashboardRuntime().credentials.save(credential);
}

export async function clearCredential(): Promise<void> {
  await getDashboardRuntime().credentials.clear();
}

export function createCredential(
  runtime: DashboardRuntimeV1,
  session: Session,
  member: Member,
  memberToken?: string,
): SavedCredential {
  if (runtime.kind === "desktop") {
    return { session, member, authorization: { kind: "desktop-managed" } };
  }
  if (!memberToken) throw new Error("Relay 没有返回成员凭据");
  return {
    session,
    member,
    authorization: { kind: "browser-bearer", bearerToken: memberToken },
  };
}

export function updateCredential(
  credential: SavedCredential,
  session: Session,
  member: Member,
): SavedCredential {
  return { ...credential, session, member };
}

export function credentialAccessKey(
  credential: SavedCredential | null,
): string | null {
  if (!credential) return null;
  return credential.authorization.kind === "browser-bearer"
    ? credential.authorization.bearerToken
    : "desktop-managed";
}

export function credentialAuthorization(
  credential: SavedCredential | null,
): string | undefined {
  return credential?.authorization.kind === "browser-bearer"
    ? credential.authorization.bearerToken
    : undefined;
}

export function credentialHeaders(
  credential: SavedCredential | null,
  includeJson = false,
): HeadersInit {
  const authorization = credentialAuthorization(credential);
  return {
    ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
    ...(includeJson ? { "content-type": "application/json" } : {}),
  };
}

export function deviceLabel(): string {
  return getDashboardRuntime().deviceLabel;
}

export function inviteTokenFromLocation(): string {
  return getDashboardRuntime().inviteToken;
}

export function clearInviteFromLocation(): void {
  getDashboardRuntime().clearInviteLocation();
}

export function inviteLinkForCurrentOrigin(inviteToken: string): string {
  const url = new URL("/", getDashboardRuntime().publicRelayOrigin);
  url.hash = new URLSearchParams({ invite: inviteToken }).toString();
  return url.toString();
}

export function isLoopbackOrigin(): boolean {
  return getDashboardRuntime().isLoopbackOrigin;
}
