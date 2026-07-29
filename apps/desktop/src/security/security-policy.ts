import { isAbsolute, relative, resolve, sep } from "node:path";

export const DESKTOP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const MIME_BY_EXTENSION = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
]);

export interface ResolvedDesktopAsset {
  absolutePath: string;
  cacheControl: string;
  contentType: string;
}

function rawPathname(rawUrl: string): string | null {
  const match = rawUrl.match(/^codex-collab:\/\/([^/?#]*)([^?#]*)/i);
  return match?.[2] ?? null;
}

function extensionOf(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex < 0 ? "" : fileName.slice(dotIndex).toLowerCase();
}

function ensureInsideRoot(root: string, target: string): void {
  const child = relative(root, target);
  if (
    !child ||
    isAbsolute(child) ||
    child === ".." ||
    child.startsWith(`..${sep}`)
  ) {
    throw new Error("desktop_asset_path_rejected");
  }
}

export function resolveDesktopAsset(
  rawUrl: string,
  method: string,
  rendererRoot: string,
): ResolvedDesktopAsset {
  if (method !== "GET") throw new Error("desktop_asset_method_rejected");

  const rawPath = rawPathname(rawUrl);
  if (
    rawPath === null ||
    /%(?:2e|2f|5c|00|25)/i.test(rawPath) ||
    rawPath.includes("\\") ||
    rawPath.includes("\0") ||
    rawPath.includes("..")
  ) {
    throw new Error("desktop_asset_path_rejected");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("desktop_asset_url_rejected");
  }
  if (
    url.protocol !== "codex-collab:" ||
    url.hostname !== "app" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("desktop_asset_url_rejected");
  }

  const pathname = decodeURIComponent(url.pathname);
  let relativePath: string;
  if (pathname === "/" || pathname === "/index.html") {
    relativePath = "index.html";
  } else {
    const match = pathname.match(/^\/assets\/([^/]+)$/);
    if (!match?.[1] || !ASSET_NAME.test(match[1])) {
      throw new Error("desktop_asset_path_rejected");
    }
    relativePath = `assets/${match[1]}`;
  }

  const extension = extensionOf(relativePath);
  const contentType = MIME_BY_EXTENSION.get(extension);
  if (!contentType) throw new Error("desktop_asset_type_rejected");

  const absoluteRoot = resolve(rendererRoot);
  const absolutePath = resolve(absoluteRoot, relativePath);
  ensureInsideRoot(absoluteRoot, absolutePath);
  return {
    absolutePath,
    contentType,
    cacheControl:
      relativePath === "index.html"
        ? "no-store"
        : "public, max-age=31536000, immutable",
  };
}

export function isTrustedRendererFrame(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "codex-collab:" &&
      url.hostname === "app" &&
      url.pathname === "/index.html" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function validatedExternalUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || rawUrl.length < 1 || rawUrl.length > 2_048) {
    throw new Error("external_url_rejected");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("external_url_rejected");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("external_url_rejected");
  }
  return url.toString();
}

export interface ValidatedDesktopNotification {
  title: string;
  body: string;
}

function notificationText(
  value: unknown,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("notification_rejected");
  }
  return value;
}

export function validatedNotification(
  input: unknown,
): ValidatedDesktopNotification {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("notification_rejected");
  }
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("title") || !keys.includes("body")) {
    throw new Error("notification_rejected");
  }
  const candidate = input as { title?: unknown; body?: unknown };
  return {
    title: notificationText(candidate.title, 80),
    body: notificationText(candidate.body, 160),
  };
}
