import { describe, expect, it } from "vitest";
import {
  panelVisibilityStorageKey,
  readWorkspacePanelVisibility,
} from "./useWorkspacePanelVisibility.js";

describe("workspace panel visibility", () => {
  it("opens chat and files by default", () => {
    const storage = { getItem: () => null };

    expect(readWorkspacePanelVisibility("room:task", storage)).toEqual({
      collaboration: true,
      files: true,
    });
  });

  it("restores valid task-scoped visibility", () => {
    const key = panelVisibilityStorageKey("room:task");
    const storage = {
      getItem: (candidate: string) =>
        candidate === key
          ? JSON.stringify({ collaboration: false, files: true })
          : null,
    };

    expect(readWorkspacePanelVisibility("room:task", storage)).toEqual({
      collaboration: false,
      files: true,
    });
  });

  it("falls back safely for invalid stored values", () => {
    const storage = { getItem: () => "not-json" };

    expect(readWorkspacePanelVisibility("room:task", storage)).toEqual({
      collaboration: true,
      files: true,
    });
  });
});
