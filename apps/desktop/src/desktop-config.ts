export interface DesktopConfig {
  publicRelayOrigin: string;
}

const DEFAULT_PRIMARY_RELAY_ORIGIN =
  "https://codex-collab.217.194.133.194.sslip.io";

export function normalizeRelayOrigin(
  rawValue: string,
  allowLoopbackHttp: boolean,
): string {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error("CODEX_COLLAB_RELAY_URL must be an absolute URL.");
  }
  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1";
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(allowLoopbackHttp && isLoopback && url.protocol === "http:"))
  ) {
    throw new Error("CODEX_COLLAB_RELAY_URL is not an approved Relay origin.");
  }
  return url.origin;
}

export function resolveDesktopConfig(
  environment: NodeJS.ProcessEnv,
  isPackaged: boolean,
): DesktopConfig {
  return {
    publicRelayOrigin: normalizeRelayOrigin(
      environment.CODEX_COLLAB_RELAY_URL ?? DEFAULT_PRIMARY_RELAY_ORIGIN,
      !isPackaged,
    ),
  };
}
