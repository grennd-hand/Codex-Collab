import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    hostGeneration: "generation-1",
    expectedSha256: null,
    status: "processing",
    resultFileMetadata: null,
    resultFile: null,
    errorCode: null,
    errorMessage: null,
    requestedAt: "2026-07-27T00:00:00.000Z",
    startedAt: "2026-07-27T00:00:01.000Z",
    completedAt: null,
    requestContent: null,
    leaseId: "lease-1",
    ...input,
  };
}

describe("workspace file operation host execution", () => {
  it("reads and writes through FileSandbox with an observed SHA-256", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "main.ts"), "before", "utf8");
    const sandbox = await FileSandbox.create(root);
    const original = await sandbox.read("main.ts");

    const readResult = await executeWorkspaceFileOperation(
      operation({ kind: "read", path: "main.ts" }),
      sandbox,
    );
    expect(readResult).toMatchObject({
      status: "completed",
      file: { content: "before", sha256: original.sha256 },
    });

    const writeResult = await executeWorkspaceFileOperation(
      operation({
        kind: "write",
        path: "main.ts",
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
    expect(await readFile(join(root, "main.ts"), "utf8")).toBe("after");
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
      errorCode: "workspace_file_not_shared",
    });
  });

  it("applies ignore exact and directory-prefix rules to direct reads", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "generated"));
    await writeFile(
      join(root, ".codex-collabignore"),
      "private.ts\ngenerated/\n",
      "utf8",
    );
    await writeFile(join(root, "private.ts"), "export const privateValue = 1;", "utf8");
    await writeFile(join(root, "generated", "bundle.ts"), "export {};", "utf8");
    const sandbox = await FileSandbox.create(root);

    for (const path of ["private.ts", "generated/bundle.ts"]) {
      await expect(
        executeWorkspaceFileOperation(operation({ kind: "read", path }), sandbox),
      ).resolves.toEqual({
        status: "failed",
        errorCode: "workspace_file_not_shared",
        errorMessage: "This file is not available to the collaboration editor",
      });
    }
  });

  it("does not return guessed-key or custom-token text content", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "deploy-key.txt"),
      "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
      "utf8",
    );
    await writeFile(
      join(root, "settings.txt"),
      "ACCESS_TOKEN=custom-super-secret-token-123456",
      "utf8",
    );
    const sandbox = await FileSandbox.create(root);

    for (const path of ["deploy-key.txt", "settings.txt"]) {
      const result = await executeWorkspaceFileOperation(
        operation({ kind: "read", path }),
        sandbox,
      );
      expect(result).toEqual({
        status: "failed",
        errorCode: "workspace_file_not_shared",
        errorMessage: "This file is not available to the collaboration editor",
      });
      expect(result).not.toHaveProperty("file");
    }
  });

  it("suppresses the authoritative file when a conflict reveals a secret", async () => {
    const root = await tempRoot();
    const path = join(root, "config.ts");
    await writeFile(path, "export const mode = 'safe';", "utf8");
    const sandbox = await FileSandbox.create(root);
    const base = await sandbox.read("config.ts");
    await writeFile(path, "ACCESS_TOKEN=custom-super-secret-token-123456", "utf8");

    const result = await executeWorkspaceFileOperation(
      operation({
        kind: "write",
        path: "config.ts",
        requestContent: "export const mode = 'edited';",
        expectedSha256: base.sha256,
      }),
      sandbox,
    );

    expect(result).toMatchObject({ status: "failed", errorCode: "file_conflict" });
    expect(result).not.toHaveProperty("file");
  });
});
