import { describe, expect, it, vi } from "vitest";
import {
  monacoModelUri,
  monacoModelScope,
  releaseTaskMonacoModels,
  releaseWorkspaceMonacoModels,
  retainMonacoModel,
  safeScopeHash,
  type RetainedMonacoModel,
} from "./monaco-model-registry.js";

function model(uri: string): RetainedMonacoModel & { dispose: ReturnType<typeof vi.fn> } {
  let disposed = false;
  const dispose = vi.fn(() => {
    disposed = true;
  });
  return {
    dispose,
    isDisposed: () => disposed,
    uri: { toString: () => uri },
  };
}

describe("Monaco model registry", () => {
  it("uses a deterministic URL-safe scope hash without leaking scope values", () => {
    const scope = JSON.stringify(["session-secret", "Project", "thread-a"]);
    const uri = monacoModelUri(scope, "src/My File.tsx");

    expect(safeScopeHash(scope)).toMatch(/^[a-f0-9]{32}$/);
    expect(uri).toMatch(
      /^codex-collab:\/\/workspace\/[a-f0-9]{32}\/src\/My%20File\.tsx$/,
    );
    expect(uri).not.toContain("session-secret");
    expect(monacoModelUri(scope, "src/App.tsx")).not.toBe(
      monacoModelUri("other-task", "src/App.tsx"),
    );
  });

  it("retains closed-tab models and disposes them at workspace release", () => {
    const first = model("codex-collab://workspace/a/file.ts");
    const second = model("codex-collab://workspace/b/file.ts");
    retainMonacoModel("workspace-a", "task-a", "scope-a", first);
    retainMonacoModel("workspace-b", "task-b", "scope-b", second);

    releaseWorkspaceMonacoModels("workspace-a");

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).not.toHaveBeenCalled();
    releaseWorkspaceMonacoModels("workspace-b");
  });

  it("can release one task without disposing models retained by another task", () => {
    const first = model("codex-collab://workspace/a/task-a.ts");
    const second = model("codex-collab://workspace/a/task-b.ts");
    retainMonacoModel("workspace", "task-a", "scope-a", first);
    retainMonacoModel("workspace", "task-b", "scope-b", second);

    releaseTaskMonacoModels("task-a");

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).not.toHaveBeenCalled();
    releaseWorkspaceMonacoModels("workspace");
  });

  it("forgets opaque scope mappings after their workspace is released", () => {
    const scope = monacoModelScope("workspace-release", "task-release");
    const firstId = safeScopeHash(scope);
    const retained = model(`codex-collab://workspace/${firstId}/file.ts`);
    retainMonacoModel(
      "workspace-release",
      "task-release",
      scope,
      retained,
    );

    releaseWorkspaceMonacoModels("workspace-release");

    expect(safeScopeHash(scope)).not.toBe(firstId);
  });
});
