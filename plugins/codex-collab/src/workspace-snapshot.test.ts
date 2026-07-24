import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileSandbox } from "./file-sandbox.js";
import {
  buildWorkspaceSnapshot,
  buildCodexConfigSnapshot,
  containsLikelySecret,
  isPublishableCodexConfigPath,
  isPublishableWorkspacePath,
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

    const sandbox = await FileSandbox.create(root);
    const files = await buildWorkspaceSnapshot(sandbox);
    expect(files.map((file) => file.path)).toEqual(["README.md"]);
    expect(files[0]?.content).toBe("# Safe project\n");
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
