import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openBoundProjectSandbox,
  openProjectSandbox,
  openWorkspaceSandboxes,
} from "./workspace-roots.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-collab-roots-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace root policy", () => {
  it("rejects project roots equal to or nested inside .codex", async () => {
    const base = await tempRoot();
    const config = join(base, ".codex");
    const nested = join(config, "projects", "unsafe");
    await mkdir(nested, { recursive: true });

    await expect(openProjectSandbox(config)).rejects.toThrow(/cannot be a .codex/i);
    await expect(openProjectSandbox(nested)).rejects.toThrow(/cannot be a .codex/i);
  });

  it("rejects project and explicit Codex config roots that overlap", async () => {
    const project = await tempRoot();
    const nestedConfig = join(project, ".codex");
    await mkdir(nestedConfig, { recursive: true });

    await expect(openWorkspaceSandboxes(project, nestedConfig)).rejects.toThrow(/overlap/i);
  });

  it("accepts separate canonical project and Codex config roots", async () => {
    const base = await tempRoot();
    const project = join(base, "project");
    const config = join(base, "profile", ".codex");
    await Promise.all([
      mkdir(project, { recursive: true }),
      mkdir(config, { recursive: true }),
    ]);

    const roots = await openWorkspaceSandboxes(project, config);
    expect(roots.projectSandbox.getRoot()).toBe(await openProjectSandbox(project).then((s) => s.getRoot()));
    expect(roots.codexConfigSandbox?.getRoot()).toMatch(/\.codex$/i);
  });

  it("does not let thread binding rotate the approved project root", async () => {
    const current = await tempRoot();
    const other = await tempRoot();

    await expect(openBoundProjectSandbox(current, other)).rejects.toThrow(/pair the host again/i);
    await expect(openBoundProjectSandbox(current, current)).resolves.toBeDefined();
  });
});
