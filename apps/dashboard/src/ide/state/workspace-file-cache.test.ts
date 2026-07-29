import { describe, expect, it } from "vitest";
import {
  WorkspaceFileCache,
  taskUiScope,
  workspaceDataScope,
  workspaceFileCacheKey,
  workspaceRootScope,
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
  it("scopes project state to the paired root instead of the selected task", () => {
    expect(workspaceRootScope("session", "Owner PC", "Project")).not.toBe(
      workspaceRootScope("session", "Owner PC", "Other Project"),
    );
  });

  it("separates workspace data identity from task UI identity", () => {
    expect(workspaceDataScope("session", "Owner PC", "Project")).toBe(
      workspaceDataScope("session", "Owner PC", "Project"),
    );
    expect(taskUiScope("session", "Project", "thread-a")).not.toBe(
      taskUiScope("session", "Project", "thread-b"),
    );
    expect(taskUiScope("session", "Project", "thread-a")).not.toContain(
      "Owner PC",
    );
  });

  it("isolates a newly paired Host even when its labels are unchanged", () => {
    expect(workspaceDataScope("session", "Owner PC", "Project", "generation-1"))
      .not.toBe(workspaceDataScope("session", "Owner PC", "Project", "generation-2"));
    expect(taskUiScope("session", "Project", "thread", "generation-1")).not.toBe(
      taskUiScope("session", "Project", "thread", "generation-2"),
    );
  });

  it("uses stable Host identity instead of display label when available", () => {
    expect(workspaceDataScope("session", "Old label", "Project", "generation"))
      .toBe(workspaceDataScope("session", "New label", "Renamed", "generation"));
    expect(taskUiScope("session", "Old label", "thread", "generation"))
      .toBe(taskUiScope("session", "New label", "thread", "generation"));
  });

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

  it("scopes keys by paired root, path, and optimistic hash", () => {
    expect(workspaceFileCacheKey("root", "src/App.tsx", "sha")).not.toBe(
      workspaceFileCacheKey("other-root", "src/App.tsx", "sha"),
    );
  });
});
