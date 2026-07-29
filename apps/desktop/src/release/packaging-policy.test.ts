import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("Windows Internal Beta packaging", () => {
  it("pins Electron, builder and fuse tooling", async () => {
    const packageJson = JSON.parse(
      await readFile(join(desktopRoot, "package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };
    expect(packageJson.devDependencies.electron).toBe("43.2.0");
    expect(packageJson.devDependencies["electron-builder"]).toBe("26.15.3");
    expect(packageJson.devDependencies["@electron/fuses"]).toBe("2.1.3");
  });

  it("builds an unsigned per-user NSIS package that preserves app data", async () => {
    const config = await readFile(
      join(desktopRoot, "electron-builder.yml"),
      "utf8",
    );
    expect(config).toContain("target: nsis");
    expect(config).toContain("oneClick: false");
    expect(config).toContain("perMachine: false");
    expect(config).toContain("deleteAppDataOnUninstall: false");
    expect(config).toContain("electronDist: ../../node_modules/electron/dist");
    expect(config).not.toContain("publish: always");
  });

  it("packages the shared Host worker and native pipe broker", async () => {
    const packageJson = JSON.parse(
      await readFile(join(desktopRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const config = await readFile(
      join(desktopRoot, "electron-builder.yml"),
      "utf8",
    );
    expect(packageJson.dependencies?.["codex-collab"]).toBeUndefined();
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.devDependencies["codex-collab"]).toBe("0.1.0");
    expect(packageJson.devDependencies.ws).toBe("^8.18.3");
    expect(config).toContain("to: node_modules/ws");
    expect(config).toContain("to: host/dist");
    expect(config).toContain("to: host/node_modules/@codex-collab/protocol/dist");
    expect(config).toContain("codex-collab-host-ipc.exe");
    expect(config).toContain("to: native/codex-collab-host-ipc.exe");
    const packageScript = await readFile(
      join(desktopRoot, "scripts", "package-windows.mjs"),
      "utf8",
    );
    expect(packageScript).toContain("electron/install.js");
    expect(packageScript).toContain("electron_config_cache");
  });

  it("disables Electron runtime escape fuses", async () => {
    const hook = await readFile(
      join(desktopRoot, "scripts", "after-pack.mjs"),
      "utf8",
    );
    expect(hook).toContain("FuseV1Options.RunAsNode]: false");
    expect(hook).toContain("FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false");
    expect(hook).toContain("FuseV1Options.EnableNodeCliInspectArguments]: false");
    expect(hook).toContain("FuseV1Options.OnlyLoadAppFromAsar]: true");
  });
});
