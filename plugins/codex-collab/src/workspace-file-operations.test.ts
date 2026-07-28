import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWorkspacePathIgnored,
  type WorkspaceFileOperationClaim,
  type WorkspaceFileOperationConfirmation,
} from "@codex-collab/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSandbox } from "./file-sandbox.js";
import {
  executeWorkspaceFileOperation,
  processNextWorkspaceFileOperation,
} from "./workspace-file-operations.js";

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
  input: Partial<WorkspaceFileOperationConfirmation> &
    Pick<WorkspaceFileOperationConfirmation, "kind" | "path">,
): WorkspaceFileOperationConfirmation {
  return {
    id: "operation-1",
    sessionId: "session-1",
    requestedByMemberId: "member-1",
    requestedByDisplayName: "Editor",
    hostGeneration: "generation-1",
    destinationPath: null,
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
    leaseExpiresAt: "2026-07-27T00:01:00.000Z",
    ...input,
  };
}

function claim(
  input: Partial<WorkspaceFileOperationClaim> &
    Pick<WorkspaceFileOperationClaim, "kind" | "path">,
): WorkspaceFileOperationClaim {
  const { requestContent: _requestContent, ...confirmed } = operation(input);
  return { ...confirmed, expectedSha256: null, ...input };
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

  it("renames files and directories with guarded no-replace semantics", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "src", "folder"), { recursive: true });
    await writeFile(join(root, "src", "entry.ts"), "export {};", "utf8");
    const sandbox = await FileSandbox.create(root);
    const file = await sandbox.read("src/entry.ts");

    const fileResult = await executeWorkspaceFileOperation(
      operation({
        kind: "rename",
        path: "src/entry.ts",
        destinationPath: "src/entry.txt",
        expectedSha256: file.sha256,
      }),
      sandbox,
    );
    expect(fileResult).toEqual({
      status: "completed",
      file: {
        path: "src/entry.txt",
        content: "export {};",
        size: file.size,
        modifiedAt: file.modifiedAt,
        sha256: file.sha256,
      },
    });
    await expect(stat(join(root, "src", "entry.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(root, "src", "occupied.txt"), "keep", "utf8");
    await expect(
      executeWorkspaceFileOperation(
        operation({
          kind: "rename",
          path: "src/entry.txt",
          destinationPath: "src/occupied.txt",
          expectedSha256: file.sha256,
        }),
        sandbox,
      ),
    ).resolves.toMatchObject({ status: "failed", errorCode: "file_conflict" });
    expect(await readFile(join(root, "src", "occupied.txt"), "utf8")).toBe("keep");

    await expect(
      executeWorkspaceFileOperation(
        operation({
          kind: "rename",
          path: "src/folder",
          destinationPath: "src/renamed",
          expectedSha256: null,
        }),
        sandbox,
      ),
    ).resolves.toEqual({ status: "completed" });
    expect((await stat(join(root, "src", "renamed"))).isDirectory()).toBe(true);
  }, 10_000);

  it("creates new files and empty directories without overwriting existing paths", async () => {
    const root = await tempRoot();
    const sandbox = await FileSandbox.create(root);

    const fileResult = await executeWorkspaceFileOperation(
      operation({
        kind: "write",
        path: "src/new-file.ts",
        requestContent: "",
        expectedSha256: "",
      }),
      sandbox,
    );
    expect(fileResult).toMatchObject({
      status: "completed",
      file: { path: "src/new-file.ts", content: "" },
    });

    await expect(
      executeWorkspaceFileOperation(
        operation({ kind: "mkdir", path: "src/empty-folder" }),
        sandbox,
      ),
    ).resolves.toEqual({ status: "completed" });
    expect((await stat(join(root, "src", "empty-folder"))).isDirectory()).toBe(true);

    await expect(
      executeWorkspaceFileOperation(
        operation({ kind: "mkdir", path: "1" }),
        sandbox,
      ),
    ).resolves.toEqual({ status: "completed" });
    expect((await stat(join(root, "1"))).isDirectory()).toBe(true);

    await expect(
      executeWorkspaceFileOperation(
        operation({ kind: "mkdir", path: ".ssh/private" }),
        sandbox,
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "workspace_file_not_shared",
    });
  });

  it("rejects Codex configuration reads without an explicit config root", async () => {
    const root = await tempRoot();
    const sandbox = await FileSandbox.create(root);

    await expect(
      executeWorkspaceFileOperation(
        operation({ kind: "read", path: ".codex/config.toml" }),
        sandbox,
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "workspace_file_not_shared",
    });
  });

  it("rejects reads and writes below private workspace directories", async () => {
    const root = await tempRoot();
    const sandbox = await FileSandbox.create(root);

    for (const path of [
      ".aws/settings.json",
      ".azure/profile.json",
      ".gnupg/options.conf",
      ".SSH/public.txt",
      "node_modules/package/index.ts",
    ]) {
      for (const queued of [
        operation({ kind: "read", path }),
        operation({
          kind: "write",
          path,
          requestContent: "private",
          expectedSha256: "",
        }),
      ]) {
        await expect(
          executeWorkspaceFileOperation(queued, sandbox),
        ).resolves.toMatchObject({
          status: "failed",
          errorCode: "workspace_file_not_shared",
        });
      }
    }
  });

  it("reads explicitly shared Codex configuration through its separate sandbox", async () => {
    const projectRoot = await tempRoot();
    const configRoot = await tempRoot();
    await mkdir(join(configRoot, "rules"));
    await writeFile(join(configRoot, "rules", "default.rules"), "allow = true", "utf8");
    const projectSandbox = await FileSandbox.create(projectRoot);
    const configSandbox = await FileSandbox.create(configRoot);

    await expect(
      executeWorkspaceFileOperation(
        operation({ kind: "read", path: ".codex/rules/default.rules" }),
        projectSandbox,
        configSandbox,
      ),
    ).resolves.toMatchObject({
      status: "completed",
      file: {
        path: ".codex/rules/default.rules",
        content: "allow = true",
      },
    });
  });

  it("never writes Codex configuration even when a config root is explicit", async () => {
    const projectRoot = await tempRoot();
    const configRoot = await tempRoot();
    await writeFile(join(configRoot, "config.toml"), "mode = 'safe'", "utf8");
    const projectSandbox = await FileSandbox.create(projectRoot);
    const configSandbox = await FileSandbox.create(configRoot);

    await expect(
      executeWorkspaceFileOperation(
        operation({
          kind: "write",
          path: ".codex/config.toml",
          requestContent: "mode = 'unsafe'",
          expectedSha256: "a".repeat(64),
        }),
        projectSandbox,
        configSandbox,
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "workspace_file_not_shared",
    });
    expect(await readFile(join(configRoot, "config.toml"), "utf8")).toBe("mode = 'safe'");
  });

  it("rejects sensitive Codex paths and secret config content", async () => {
    const projectRoot = await tempRoot();
    const configRoot = await tempRoot();
    await writeFile(join(configRoot, "auth.json"), "{}", "utf8");
    await writeFile(
      join(configRoot, "config.toml"),
      "ACCESS_TOKEN=custom-super-secret-token-123456",
      "utf8",
    );
    const projectSandbox = await FileSandbox.create(projectRoot);
    const configSandbox = await FileSandbox.create(configRoot);

    for (const path of [".codex/auth.json", ".codex/config.toml"]) {
      const result = await executeWorkspaceFileOperation(
        operation({ kind: "read", path }),
        projectSandbox,
        configSandbox,
      );
      expect(result).toMatchObject({
        status: "failed",
        errorCode: "workspace_file_not_shared",
      });
      expect(result).not.toHaveProperty("file");
    }
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
    expect(isWorkspacePathIgnored("PRIVATE.TS", ["private.ts"], true)).toBe(true);
    expect(isWorkspacePathIgnored("PRIVATE.TS", ["private.ts"], false)).toBe(false);
    if (process.platform === "win32") {
      await expect(
        executeWorkspaceFileOperation(
          operation({ kind: "read", path: "PRIVATE.TS" }),
          sandbox,
        ),
      ).resolves.toMatchObject({
        status: "failed",
        errorCode: "workspace_file_not_shared",
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

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "workspace_file_not_shared",
    });
    expect(result).not.toHaveProperty("file");
  });

  it("confirms the lease before touching disk", async () => {
    const root = await tempRoot();
    const path = join(root, "guarded.ts");
    await writeFile(path, "original", "utf8");
    const sandbox = await FileSandbox.create(root);
    const relay = {
      claimNextWorkspaceFileOperation: vi.fn().mockResolvedValue(
        claim({
          kind: "write",
          path: "guarded.ts",
        }),
      ),
      confirmWorkspaceFileOperationLease: vi
        .fn()
        .mockRejectedValue(new Error("workspace operation lease expired")),
      completeWorkspaceFileOperation: vi.fn(),
    };

    await expect(
      processNextWorkspaceFileOperation(
        "session-1",
        "host-token",
        relay as never,
        sandbox,
      ),
    ).rejects.toThrow(/lease expired/i);
    expect(await readFile(path, "utf8")).toBe("original");
    expect(relay.completeWorkspaceFileOperation).not.toHaveBeenCalled();
  });
});
