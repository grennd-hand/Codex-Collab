import { describe, expect, it } from "vitest";
import {
  CODEX_COLLAB_DARK_EDITOR_COLORS,
  CODEX_COLLAB_LIGHT_EDITOR_COLORS,
} from "./monaco-theme.js";

describe("Codex Collab Monaco themes", () => {
  it("uses valid IDE-style colors for line and selection highlights", () => {
    for (const colors of [
      CODEX_COLLAB_LIGHT_EDITOR_COLORS,
      CODEX_COLLAB_DARK_EDITOR_COLORS,
    ]) {
      expect(Object.values(colors).every((color) => /^#[\dA-F]{6,8}$/i.test(color))).toBe(
        true,
      );
    }

    expect(
      CODEX_COLLAB_LIGHT_EDITOR_COLORS["editor.lineHighlightBackground"],
    ).toBe("#F2F6FC");
    expect(
      CODEX_COLLAB_LIGHT_EDITOR_COLORS["editor.selectionBackground"],
    ).toBe("#ADD6FF");
  });
});
