import { describe, expect, it } from "vitest";
import {
  WorkspaceFileCache,
  workspaceFileCacheKey,
} from "./workspace-file-cache.js";

function file(path: string, content: string) {
  return {
    path,
    content,
    size: content.length,
    modifiedAt: "2026-07-27T00:00:00.000Z",
    sha256: `${path}:${content}`,
  };
}

describe("WorkspaceFileCache", () => {
  it("evicts the least recently used entry at the configured bound", () => {
    const cache = new WorkspaceFileCache(2, 1024);
    cache.set("a", file("a", "a"));
    cache.set("b", file("b", "b"));
    expect(cache.get("a")?.path).toBe("a");
    cache.set("c", file("c", "c"));

    expect(cache.get("a")?.path).toBe("a");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")?.path).toBe("c");
  });

  it("does not retain a file larger than the byte budget", () => {
    const cache = new WorkspaceFileCache(32, 3);
    cache.set("large", file("large", "four"));
    expect(cache.get("large")).toBeNull();
  });

  it("scopes keys by session, selected task, path, and optimistic hash", () => {
    expect(workspaceFileCacheKey("s", "t", "src/App.tsx", "sha")).not.toBe(
      workspaceFileCacheKey("s", "other", "src/App.tsx", "sha"),
    );
  });
});
