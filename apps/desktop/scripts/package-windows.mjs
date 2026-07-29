import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDesktopArtifactVerification } from "../../../scripts/desktop/verify-desktop-artifact.mjs";

const requireFromDesktop = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "..", "..");
const runtimeRoot = join(repositoryRoot, ".runtime-data", "desktop-package");
const electronCache = join(runtimeRoot, "electron-cache");
const npmCli = process.env.npm_execpath;

if (!npmCli) throw new Error("Run Desktop packaging through npm.");
const target = process.argv[2];
if (target !== "--dir" && target !== "--win") {
  throw new Error("Desktop package target must be --dir or --win.");
}

const desktopPackage = JSON.parse(
  await readFile(join(desktopRoot, "package.json"), "utf8"),
);
const releaseRoot = join(
  desktopRoot,
  "release",
  "candidates",
  `${desktopPackage.version}-${Date.now()}`,
);

await mkdir(electronCache, { recursive: true });
const temporaryRoot = await mkdtemp(join(runtimeRoot, "temp-"));
const environment = {
  ...process.env,
  TEMP: temporaryRoot,
  TMP: temporaryRoot,
  TMPDIR: temporaryRoot,
  electron_config_cache: electronCache,
  ELECTRON_GET_USE_PROXY: process.env.ELECTRON_GET_USE_PROXY ?? "true",
};

function run(command, arguments_, cwd = repositoryRoot) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `${command} ${arguments_.join(" ")} failed (${signal ?? `exit ${code}`}).`,
        ),
      );
    });
  });
}

function runNpm(arguments_) {
  return run(process.execPath, [npmCli, ...arguments_]);
}

try {
  const electronExecutable = join(
    repositoryRoot,
    "node_modules",
    "electron",
    "dist",
    "electron.exe",
  );
  try {
    await access(electronExecutable);
  } catch {
    await run(process.execPath, [requireFromDesktop.resolve("electron/install.js")]);
  }
  const installedVersion = (
    await readFile(
      join(repositoryRoot, "node_modules", "electron", "dist", "version"),
      "utf8",
    )
  )
    .trim()
    .replace(/^v/, "");
  if (installedVersion !== "43.2.0") {
    throw new Error(`Expected Electron 43.2.0, found ${installedVersion}.`);
  }

  await runNpm(["run", "build:host", "--workspace", "@codex-collab/desktop"]);
  await runNpm(["run", "build:native-host", "--workspace", "@codex-collab/desktop"]);
  await runNpm(["run", "build", "--workspace", "@codex-collab/desktop"]);

  const builderArguments = [
    requireFromDesktop.resolve("electron-builder/cli.js"),
    "--config",
    "electron-builder.yml",
    "--win",
    target === "--dir" ? "--dir" : "nsis",
    "--x64",
    `--config.directories.output=${relative(desktopRoot, releaseRoot)}`,
  ];
  await run(process.execPath, builderArguments, desktopRoot);
  await runDesktopArtifactVerification([
    target === "--dir" ? "--unpacked-only" : "--write",
    `--release-root=${relative(repositoryRoot, releaseRoot)}`,
  ]);
  console.log(`Desktop artifacts: ${releaseRoot}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
