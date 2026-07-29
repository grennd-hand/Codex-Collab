import { describe, expect, it } from "vitest";
import {
  createEntryParentPath,
  createWorkspaceEntryPath,
  defaultCreateEntryName,
  renameWorkspaceEntryPath,
} from "./ide-create-entry.js";

describe("IDE inline entry creation", () => {
  it("creates inside the selected folder or next to the selected file", () => {
    expect(
      createEntryParentPath({ kind: "directory", path: "src/components" }, null),
    ).toBe("src/components");
    expect(
      createEntryParentPath({ kind: "file", path: "src/App.tsx" }, null),
    ).toBe("src");
    expect(createEntryParentPath(null, "README.md")).toBe("");
  });

  it("accepts an extensionless top-level folder name", () => {
    expect(defaultCreateEntryName("file")).toBe("untitled.txt");
    expect(createWorkspaceEntryPath("", "1")).toBe("1");
    expect(createWorkspaceEntryPath("src", "components")).toBe(
      "src/components",
    );
  });

  it("renames inside the current parent and permits changing the extension", () => {
    expect(renameWorkspaceEntryPath("src/App.tsx", "App.test.tsx")).toBe(
      "src/App.test.tsx",
    );
  });

  it("rejects paths and reserved names in the inline name field", () => {
    expect(() => createWorkspaceEntryPath("src", "nested/folder")).toThrow(
      /路径分隔符/,
    );
    expect(() => createWorkspaceEntryPath("", "CON")).toThrow(/保留字符/);
  });
});
