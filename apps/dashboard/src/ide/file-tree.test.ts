import { describe, expect, it } from "vitest";
import {
  buildFileTree,
  collectDirectoryPaths,
  filterFileTree,
  languageForPath,
} from "./file-tree.js";
import type { IdeWorkspaceFile } from "./types.js";

function file(path: string): IdeWorkspaceFile {
  return {
    path,
    size: 12,
    modifiedAt: "2026-07-27T00:00:00.000Z",
    sha256: path.padEnd(64, "0"),
  };
}

describe("IDE file tree", () => {
  it("builds nested folders and keeps folders before files", () => {
    const tree = buildFileTree([
      file("README.md"),
      file("src/App.tsx"),
      file("src/components/Button.tsx"),
      file("package.json"),
    ]);

    expect(tree.map((node) => node.name)).toEqual([
      "src",
      "package.json",
      "README.md",
    ]);
    expect(tree[0]?.children.map((node) => node.name)).toEqual([
      "components",
      "App.tsx",
    ]);
    expect(collectDirectoryPaths(tree)).toEqual(new Set(["src", "src/components"]));
  });

  it("normalizes Windows paths and preserves matching ancestors in search", () => {
    const tree = buildFileTree([
      file("apps\\dashboard\\src\\App.tsx"),
      file("apps/relay/src/server.ts"),
    ]);
    const filtered = filterFileTree(tree, "dashboard/src/app");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.children[0]?.children[0]?.children[0]?.path).toBe(
      "apps/dashboard/src/App.tsx",
    );
  });
});

describe("languageForPath", () => {
  it("maps common source files for Monaco", () => {
    expect(languageForPath("src/App.tsx")).toBe("typescript");
    expect(languageForPath(".github/workflows/ci.yml")).toBe("yaml");
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath("LICENSE")).toBe("plaintext");
  });
});
