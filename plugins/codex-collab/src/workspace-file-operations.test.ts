import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceFileOperationClaim } from "@codex-collab/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FileSandbox } from "./file-sandbox.js";
import { executeWorkspaceFileOperation } from "./workspace-file-operations.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-collab-operation-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function operation(
  input: Partial<WorkspaceFileOperationClaim> &
    Pick<WorkspaceFileOperationClaim, "kind" | "path">,
): WorkspaceFileOperationClaim {
  return {
    id: "operation-1",
    sessionId: "session-1",
    requestedByMemberId: "member-1",
    requestedByDisplayName: "Editor",
    expectedSha256: null,
    status: "processing",
    resultFile: null,
    errorCode: null,
    errorMessage: null,
    requestedAt: "2026-07-27T00:00:00.000Z",
    startedAt: "2026-07-27T00:00:01.000Z",
    completedAt: null,
    requestContent: null,
    ...input,
  };
}

describe("workspace file operation host execution", () => {
  it("reads and writes through FileSandbox with an observed SHA-256", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "README.md"), "before", "utf8");
    const sandbox = await FileSandbox.create(root);
    const original = await sandbox.read("README.md");

    const readResult = await executeWorkspaceFileOperation(
      operation({ kind: "read", path: "README.md" }),
      sandbox,
    );
    expect(readResult).toMatchObject({
      status: "completed",
      file: { content: "before", sha256: original.sha256 },
    });

    const writeResult = await executeWorkspaceFileOperation(
      operation({
        kind: "write",
        path: "README.md",
        requestContent: "after",
        expectedSha256: original.sha256,
      }),
      sandbox,
    );
    expect(writeResult).toMatchObject({
      status: "completed",
      file: {
        content: "after",
        sha256: createHash("sha256").update("after").digest("hex"),
      },
    });
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("after");
  });

  it("returns the authoritative current file on a stale-hash conflict without overwrite", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "shared.ts"), "base", "utf8");
    const sandbox = await FileSandbox.create(root);
    const base = await sandbox.read("shared.ts");
    await writeFile(join(root, "shared.ts"), "remote change", "utf8");

    const result = await executeWorkspaceFileOperation(
      operation({
        kind: "write",
        path: "shared.ts",
        requestContent: "local change",
        expectedSha256: base.sha256,
      }),
      sandbox,
    );

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "file_conflict",
      file: { content: "remote change" },
    });
    expect(await readFile(join(root, "shared.ts"), "utf8")).toBe("remote change");
  });

  it("defends private Codex and credential paths again on the host", async () => {
    const root = await tempRoot();
    const sandbox = await FileSandbox.create(root);

    await expect(
      executeWorkspaceFileOperation(
        operation({ kind: "read", path: ".codex/auth.json" }),
        sandbox,
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "workspace_path_not_shared",
    });
  });
});
