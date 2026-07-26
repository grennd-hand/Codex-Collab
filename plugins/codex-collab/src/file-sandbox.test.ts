import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileConflictError, FileSandbox } from "./file-sandbox.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-collab-files-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileSandbox", () => {
  it("reads and writes only inside the approved root", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "notes.md"), "first", "utf8");
    const sandbox = await FileSandbox.create(root);

    const original = await sandbox.read("notes.md");
    const updated = await sandbox.write("notes.md", "second", original.sha256);

    expect(updated.content).toBe("second");
    await expect(sandbox.read("../outside.txt")).rejects.toThrow(/outside/i);
  });

  it("rejects stale optimistic hashes", async () => {
    const root = await tempRoot();
    const path = join(root, "shared.txt");
    await writeFile(path, "version one", "utf8");
    const sandbox = await FileSandbox.create(root);
    const firstRead = await sandbox.read("shared.txt");

    await writeFile(path, "changed elsewhere", "utf8");
    await expect(sandbox.write("shared.txt", "my edit", firstRead.sha256)).rejects.toBeInstanceOf(
      FileConflictError,
    );
    expect(await readFile(path, "utf8")).toBe("changed elsewhere");
  });

  it("rechecks the hash immediately before rename", async () => {
    const root = await tempRoot();
    const path = join(root, "shared.ts");
    await writeFile(path, "version one", "utf8");
    const reader = await FileSandbox.create(root);
    const firstRead = await reader.read("shared.ts");
    const sandbox = await FileSandbox.create(root, {
      beforeFinalWriteCheck: async (absolutePath) => {
        await writeFile(absolutePath, "external edit", "utf8");
      },
    });

    await expect(
      sandbox.write("shared.ts", "collaboration edit", firstRead.sha256),
    ).rejects.toBeInstanceOf(FileConflictError);
    expect(await readFile(path, "utf8")).toBe("external edit");
  });

  it("rejects a nested symlink escape before creating directories outside the root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, join(root, "escape"), "junction");
    const sandbox = await FileSandbox.create(root);

    await expect(
      sandbox.write("escape/new/danger.txt", "blocked", ""),
    ).rejects.toThrow(/symbolic link/i);
    await expect(readFile(join(outside, "new", "danger.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not expose internal prompt attachment staging", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "visible.txt"), "visible", "utf8");
    await mkdir(join(root, ".codex-collab", "attachments-1"), {
      recursive: true,
    });
    await writeFile(
      join(root, ".codex-collab", "attachments-1", "private.txt"),
      "private",
      "utf8",
    );
    const sandbox = await FileSandbox.create(root);

    await expect(sandbox.list()).resolves.toEqual([
      expect.objectContaining({ path: "visible.txt" }),
    ]);
  });

  it("skips host runtime data and caller-provided path prefixes", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".runtime-data"), { recursive: true });
    await mkdir(join(root, "public", "assets"), { recursive: true });
    await writeFile(join(root, ".runtime-data", "deploy.ps1"), "private", "utf8");
    await writeFile(join(root, "public", "assets", "index.js"), "generated", "utf8");
    await writeFile(join(root, "visible.ts"), "export {};", "utf8");
    const sandbox = await FileSandbox.create(root);

    await expect(sandbox.list(2_000, ["public/assets/"])).resolves.toEqual([
      expect.objectContaining({ path: "visible.ts" }),
    ]);
  });
});
