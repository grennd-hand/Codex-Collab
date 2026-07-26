import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
    const journalRoot = join(root, ".codex-collab", "recovery");
    const recoveries = await readdir(join(journalRoot, "recovery"));
    const metadataFiles = await readdir(join(journalRoot, "metadata"));
    expect(recoveries).toHaveLength(1);
    expect(metadataFiles).toEqual(recoveries);
    expect(await readFile(join(journalRoot, "recovery", recoveries[0]!), "utf8")).toBe(
      "first",
    );
    expect(
      JSON.parse(
        await readFile(join(journalRoot, "metadata", metadataFiles[0]!), "utf8"),
      ),
    ).toMatchObject({
      target: "notes.md",
      expectedSha256: original.sha256,
      requestedSha256: updated.sha256,
      phase: "replacement-committed",
    });
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

  it("atomically restores an external race and retains recovery journals", async () => {
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
    const recoveryRoot = join(root, ".codex-collab", "recovery");
    const recoveryFiles = await readdir(join(recoveryRoot, "recovery"));
    const displacedFiles = await readdir(join(recoveryRoot, "displaced"));
    expect(recoveryFiles).toHaveLength(1);
    expect(displacedFiles).toHaveLength(1);
    expect(
      await readFile(join(recoveryRoot, "recovery", recoveryFiles[0]!), "utf8"),
    ).toBe("external edit");
    expect(
      await readFile(join(recoveryRoot, "displaced", displacedFiles[0]!), "utf8"),
    ).toBe("collaboration edit");
  });

  it("publishes new files without clobbering a concurrently created target", async () => {
    const root = await tempRoot();
    const target = join(root, "new.ts");
    const sandbox = await FileSandbox.create(root, {
      beforeFinalWriteCheck: async () => {
        await writeFile(target, "external new file", "utf8");
      },
    });

    await expect(sandbox.write("new.ts", "collaboration file", "")).rejects.toBeInstanceOf(
      FileConflictError,
    );
    expect(await readFile(target, "utf8")).toBe("external new file");
  });

  it("uses exclusive random candidate creation and cannot follow a preoccupied symlink", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const victim = join(outside, "victim.ts");
    await writeFile(victim, "outside stays safe", "utf8");
    let candidateName = "";
    const sandbox = await FileSandbox.create(root, {
      beforeCandidateOpen: async (candidate) => {
        candidateName = candidate.split(/[\\/]/).at(-1) ?? "";
        await symlink(outside, candidate, "junction");
      },
    });

    await expect(sandbox.write("new.ts", "blocked", "")).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(candidateName).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await readFile(victim, "utf8")).toBe("outside stays safe");
    await expect(readFile(join(root, "new.ts"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails writes closed when Windows replacement support is unavailable", async () => {
    const root = await tempRoot();
    const path = join(root, "shared.ts");
    await writeFile(path, "original", "utf8");
    const sandbox = await FileSandbox.create(root, { platform: "linux" });

    await expect(sandbox.write("shared.ts", "blocked")).rejects.toThrow(
      /Windows atomic file replacement support/i,
    );
    expect(await readFile(path, "utf8")).toBe("original");
  });

  it("rejects a recovery journal symlink escape before creating candidates", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const path = join(root, "shared.ts");
    await writeFile(path, "original", "utf8");
    await mkdir(join(root, ".codex-collab"));
    await symlink(
      outside,
      join(root, ".codex-collab", "recovery"),
      "junction",
    );
    const sandbox = await FileSandbox.create(root);
    const original = await sandbox.read("shared.ts");

    await expect(
      sandbox.write("shared.ts", "blocked", original.sha256),
    ).rejects.toThrow(/recovery journal/i);
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(outside)).toEqual([]);
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

  it("matches ignore entries with host filesystem case semantics", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "Private.ts"), "export {};", "utf8");
    const sandbox = await FileSandbox.create(root);

    const files = await sandbox.list(2_000, ["private.ts"]);
    if (process.platform === "win32") {
      expect(files).toEqual([]);
    } else {
      expect(files).toEqual([expect.objectContaining({ path: "Private.ts" })]);
    }
  });
});
