import { join } from "node:path";

export const DESKTOP_ICON_FILE_NAME = "codex-collab.ico";

export function resolveDesktopDevelopmentIconPath(
  mainOutputDirectory: string,
): string {
  return join(
    mainOutputDirectory,
    "..",
    "..",
    "assets",
    DESKTOP_ICON_FILE_NAME,
  );
}
