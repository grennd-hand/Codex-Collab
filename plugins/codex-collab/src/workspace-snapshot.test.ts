import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileSandbox } from "./file-sandbox.js";
import {
  buildWorkspaceSnapshot,
  buildWorkspaceSnapshotManifest,
  buildWorkspaceDirectories,
  buildCodexConfigSnapshot,
  containsLikelySecret,
  isPublishableCodexConfigPath,
  isPublishableWorkspacePath,
  parseCollabIgnore,
} from "./workspace-snapshot.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workspace snapshot", () => {
  it("publishes ordinary source and documentation while excluding credential files", () => {
    expect(isPublishableWorkspacePath("src/App.tsx")).toBe(true);
    expect(isPublishableWorkspacePath("README.md")).toBe(true);
    expect(isPublishableWorkspacePath(".env.production")).toBe(false);
    expect(isPublishableWorkspacePath(".codex/auth.json")).toBe(false);
    expect(
      isPublishableWorkspacePath(".codex-collab/attachments-1/prompt.txt"),
    ).toBe(false);
    for (const path of [
      ".aws/settings.json",
      ".azure/profile.json",
      ".gnupg/options.conf",
      ".SSH/public.txt",
      "node_modules/package/index.ts",
    ]) {
      expect(isPublishableWorkspacePath(path)).toBe(false);
    }
    expect(isPublishableWorkspacePath("keys/server.pem")).toBe(false);
    expect(isPublishableCodexConfigPath("config.toml")).toBe(true);
    expect(isPublishableCodexConfigPath("rules/default.rules")).toBe(true);
    expect(isPublishableCodexConfigPath("auth.json")).toBe(false);
    expect(isPublishableCodexConfigPath("sessions/thread.json")).toBe(false);
    expect(isPublishableCodexConfigPath("memories/MEMORY.md")).toBe(false);
    expect(isPublishableCodexConfigPath("attachments/prompt.txt")).toBe(false);
    expect(isPublishableCodexConfigPath("state.json")).toBe(false);
  });

  it("detects high-confidence embedded secrets", () => {
    expect(containsLikelySecret("const title = 'safe';")).toBe(false);
    expect(containsLikelySecret("-----BEGIN PRIVATE KEY-----\nabc")).toBe(true);
    expect(containsLikelySecret("API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
  });

  it("parses explicit collaboration exclusions without supporting negation", () => {
    expect(
      parseCollabIgnore("# generated\n.runtime-data/\napps/relay/public/\n!README.md\n"),
    ).toEqual([".runtime-data/", "apps/relay/public/"]);
  });

  it("builds a view-only snapshot without secret-bearing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-collab-snapshot-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "README.md"), "# Safe project\n", "utf8");
    await writeFile(
      join(root, "config.ts"),
      'export const key = "sk-abcdefghijklmnopqrstuvwxyz123456";\n',
      "utf8",
    );
    await writeFile(join(root, ".env"), "PASSWORD=not-for-sharing\n", "utf8");
    await mkdir(join(root, ".codex-collab", "attachments-1"), {
      recursive: true,
    });
    await writeFile(
      join(root, ".codex-collab", "attachments-1", "prompt.txt"),
      "private prompt attachment\n",
      "utf8",
    );

    const sandbox = await FileSandbox.create(root);
    const files = await buildWorkspaceSnapshot(sandbox);
    expect(files.map((file) => file.path)).toEqual(["README.md"]);
    expect(files[0]?.content).toBe("# Safe project\n");
  });

  it("does not enumerate files below private workspace directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-collab-private-dirs-"));
    temporaryRoots.push(root);
    for (const [directory, file] of [
      [".aws", "settings.json"],
      [".azure", "profile.json"],
      [".gnupg", "options.conf"],
      [".ssh", "public.txt"],
      ["node_modules/package", "index.ts"],
    ] as const) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, file), "private", "utf8");
    }
    await writeFile(join(root, "README.md"), "# Shared\n", "utf8");

    const files = await FileSandbox.create(root).then((sandbox) => sandbox.list());
    expect(files.map((file) => file.path)).toEqual(["README.md"]);
  });

  it("preserves an UTF-8 BOM with byte-consistent snapshot metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-collab-bom-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "bom.ts"), Buffer.from("\uFEFFexport {};", "utf8"));

    const [file] = await buildWorkspaceSnapshot(await FileSandbox.create(root));
    expect(file?.content.startsWith("\uFEFF")).toBe(true);
    expect(file?.size).toBe(Buffer.byteLength(file!.content));
    expect(file?.sha256).toBe(
      await FileSandbox.create(root).then((sandbox) => sandbox.read("bom.ts"))
        .then((read) => read.sha256),
    );
  });

  it("honors project-specific collaboration exclusions", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-collab-ignore-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, ".codex-collabignore"), "generated/\n", "utf8");
    await writeFile(join(root, "generated", "bundle.js"), "generated", "utf8");
    await writeFile(join(root, "source.ts"), "export const ready = true;\n", "utf8");

    const files = await buildWorkspaceSnapshot(await FileSandbox.create(root));
    expect(files.map((file) => file.path)).toEqual(["source.ts"]);
  });

  it("publishes safe empty directories without exposing private roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-collab-directories-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "src", "empty"), { recursive: true });
    await mkdir(join(root, ".ssh", "private"), { recursive: true });

    const directories = await buildWorkspaceDirectories(await FileSandbox.create(root));
    expect(directories).toEqual(["src", "src/empty"]);
  });

  it("changes its lightweight manifest when a local file or folder is deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-collab-manifest-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "src", "empty"), { recursive: true });
    await writeFile(join(root, "src", "local.ts"), "export {};\n", "utf8");
    const sandbox = await FileSandbox.create(root);
    const before = await buildWorkspaceSnapshotManifest(sandbox);

    await rm(join(root, "src"), { recursive: true, force: true });
    const after = await buildWorkspaceSnapshotManifest(sandbox);

    expect(after.digest).not.toBe(before.digest);
    expect(before.directories).toEqual(["src", "src/empty"]);
    expect(after.directories).toEqual([]);
  });

  it("publishes an explicitly separate non-credential .codex configuration snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-collab-config-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "rules"), { recursive: true });
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "config.toml"), "model = \"gpt-5\"\n", "utf8");
    await writeFile(join(root, "rules", "default.rules"), "allow = [\"git status\"]\n", "utf8");
    await writeFile(join(root, "auth.json"), "{\"token\":\"must-not-leave-host\"}\n", "utf8");
    await writeFile(join(root, "sessions", "thread.json"), "{\"history\":true}\n", "utf8");

    const sandbox = await FileSandbox.create(root);
    const files = await buildCodexConfigSnapshot(sandbox);
    expect(files).toHaveLength(2);
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining([".codex/config.toml", ".codex/rules/default.rules"]),
    );
  });
});
