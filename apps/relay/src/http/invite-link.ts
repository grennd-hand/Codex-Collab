interface ResolveInviteOriginInput {
  configuredPublicUrl?: string;
  forwardedProto?: string;
  hostHeader?: string;
  listenHost: string;
  listenPort: number;
  trustProxy: boolean;
}

function httpOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CODEX_COLLAB_PUBLIC_URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("CODEX_COLLAB_PUBLIC_URL must not contain credentials");
  }
  return url.origin;
}

export function resolveInviteOrigin(input: ResolveInviteOriginInput): string {
  if (input.configuredPublicUrl?.trim()) {
    return httpOrigin(input.configuredPublicUrl.trim());
  }

  const forwardedProto = input.forwardedProto?.split(",", 1)[0]?.trim().toLowerCase();
  const protocol =
    input.trustProxy && (forwardedProto === "http" || forwardedProto === "https")
      ? forwardedProto
      : "http";
  const host = input.hostHeader?.trim() || `${input.listenHost}:${input.listenPort}`;
  return httpOrigin(`${protocol}://${host}`);
}

export function buildInviteLink(origin: string, inviteToken: string): string {
  const url = new URL("/", httpOrigin(origin));
  url.hash = new URLSearchParams({ invite: inviteToken }).toString();
  return url.toString();
}
