import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const desktopRoot = join(repositoryRoot, "apps", "desktop");
const defaultReleaseRoot = join(desktopRoot, "release");
const requireFromRepository = createRequire(join(repositoryRoot, "package.json"));

const EXPECTED_ELECTRON = "43.2.0";
const EXPECTED_BUILDER = "26.15.3";
const SBOM_NAME = "Codex-Collab-desktop.spdx.json";
const MANIFEST_NAME = "build-manifest.json";
const CHECKSUM_NAME = "SHA256SUMS";

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\/+/, "");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function fail(message) {
  throw new Error(`Desktop artifact verification failed: ${message}`);
}

export function sensitivePackagedPath(path) {
  const normalized = normalizePath(path).toLowerCase();
  const name = basename(normalized);
  const segments = normalized.split("/");
  if (segments.some((segment) => /^\.env(?:\.|$)/.test(segment))) return true;
  if (/\.(?:sqlite|sqlite3|db|wal|shm)$/.test(name)) return true;
  if (
    [
      "auth.json",
      "owner-session.bin",
      "profile.json",
      "profiles.json",
      "token.json",
      "tokens.json",
    ].includes(name)
  ) {
    return true;
  }
  if (/\.(?:token|profile)$/.test(name)) return true;
  return /(?:^|\/)(?:guest-config|guest-runtime|guest-profile)(?:[./-]|$)/.test(
    normalized,
  );
}

function resemblesSecret(value) {
  const lowered = value.toLowerCase();
  if (
    ["example", "placeholder", "redacted", "undefined", "changeme"].some(
      (marker) => lowered.includes(marker),
    )
  ) {
    return false;
  }
  return value.length >= 20 && !/\s/.test(value);
}

export function findObviousCredential(path, contents) {
  const normalized = normalizePath(path);
  if (!/\.(?:c?js|mjs|json|html|css|ya?ml|txt)$/i.test(normalized)) return null;
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(contents)) {
    return "private key material";
  }
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/.test(contents)) {
    return "provider credential literal";
  }
  if (/\bBearer\s+[A-Za-z0-9._~-]{20,}/i.test(contents)) {
    return "bearer credential literal";
  }
  if (/\b(?:postgres(?:ql)?|mysql):\/\/[^\s/:]+:[^\s/@]+@/i.test(contents)) {
    return "credential-bearing database URL";
  }
  const assignment =
    /(?:api[_-]?key|owner[_-]?token|member[_-]?token|bearer[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of contents.matchAll(assignment)) {
    if (resemblesSecret(match[1])) return "credential assignment literal";
  }
  return null;
}

function shouldInspectContent(path) {
  const normalized = normalizePath(path);
  return (
    normalized === "package.json" ||
    normalized.startsWith("dist/main/") ||
    normalized.startsWith("dist/renderer/")
  );
}

async function validatePinnedToolchain() {
  const packageJson = await readJson(join(desktopRoot, "package.json"));
  if (packageJson.devDependencies?.electron !== EXPECTED_ELECTRON) {
    fail(`Electron must be pinned to ${EXPECTED_ELECTRON}.`);
  }
  if (packageJson.devDependencies?.["electron-builder"] !== EXPECTED_BUILDER) {
    fail(`electron-builder must be pinned to ${EXPECTED_BUILDER}.`);
  }

  const lock = await readJson(join(repositoryRoot, "package-lock.json"));
  const workspace = lock.packages?.["apps/desktop"];
  if (workspace?.devDependencies?.electron !== EXPECTED_ELECTRON) {
    fail("package-lock.json does not contain the pinned Desktop Electron dependency.");
  }
  if (workspace?.devDependencies?.["electron-builder"] !== EXPECTED_BUILDER) {
    fail("package-lock.json does not contain the pinned Desktop builder dependency.");
  }
  if (lock.packages?.["node_modules/electron"]?.version !== EXPECTED_ELECTRON) {
    fail(`package-lock.json did not resolve Electron ${EXPECTED_ELECTRON}.`);
  }
  if (
    lock.packages?.["node_modules/electron-builder"]?.version !== EXPECTED_BUILDER
  ) {
    fail(`package-lock.json did not resolve electron-builder ${EXPECTED_BUILDER}.`);
  }

  const builder = await readFile(join(desktopRoot, "electron-builder.yml"), "utf8");
  const required = [
    "asar: true",
    "electronDist: ../../node_modules/electron/dist",
    "target: nsis",
    "arch:\n        - x64",
    "oneClick: false",
    "perMachine: false",
    "deleteAppDataOnUninstall: false",
    "publish: null",
  ];
  for (const setting of required) {
    if (!builder.includes(setting)) fail(`electron-builder.yml is missing ${setting}.`);
  }
  const publishValue = builder.match(/^publish:\s*(.*)$/m)?.[1]?.trim();
  if (
    /certificateFile:|certificatePassword:/.test(builder) ||
    publishValue !== "null"
  ) {
    fail("the internal Beta must remain unsigned and must not publish automatically.");
  }
  return packageJson;
}

async function protocolVersions() {
  const sources = {
    relay: await readFile(join(repositoryRoot, "packages/protocol/src/index.ts"), "utf8"),
    hostIpc: await readFile(
      join(repositoryRoot, "plugins/codex-collab/src/host/ipc/protocol.ts"),
      "utf8",
    ),
    dashboard: await readFile(
      join(repositoryRoot, "apps/dashboard/src/shared/runtime/types.ts"),
      "utf8",
    ),
    desktopApi: await readFile(join(desktopRoot, "src/ipc-contract.ts"), "utf8"),
  };
  const extract = (source, expression, label) => {
    const match = source.match(expression);
    if (!match) fail(`cannot determine ${label} protocol version.`);
    return match[1];
  };
  return {
    relay: extract(sources.relay, /PROTOCOL_VERSION\s*=\s*["']([^"']+)/, "relay"),
    hostIpc: Number(
      extract(sources.hostIpc, /HOST_IPC_PROTOCOL_VERSION\s*=\s*(\d+)/, "Host IPC"),
    ),
    dashboardRuntime: Number(
      extract(sources.dashboard, /DASHBOARD_RUNTIME_VERSION\s*=\s*(\d+)/, "Dashboard runtime"),
    ),
    desktopApi: Number(
      extract(sources.desktopApi, /DESKTOP_API_VERSION\s*=\s*(\d+)/, "Desktop API"),
    ),
  };
}

async function inspectExtractedTree(root, displayPrefix) {
  const violations = [];
  for (const file of await filesUnder(root)) {
    const path = normalizePath(relative(root, file));
    if (sensitivePackagedPath(path)) {
      violations.push(`${displayPrefix}/${path}: forbidden runtime-data path`);
      continue;
    }
    if (!shouldInspectContent(path)) continue;
    const finding = findObviousCredential(path, await readFile(file, "utf8"));
    if (finding) violations.push(`${displayPrefix}/${path}: ${finding}`);
  }
  return violations;
}

async function inspectAsar(asarPath) {
  let asar;
  try {
    asar = requireFromRepository("@electron/asar");
  } catch {
    fail("@electron/asar is unavailable; run npm install before artifact validation.");
  }
  const entries = asar.listPackage(asarPath).map(normalizePath);
  if (entries.some((path) => path.startsWith("node_modules/codex-collab/"))) {
    fail("app.asar must not contain the shared Host implementation package.");
  }
  if (!entries.includes("node_modules/ws/wrapper.mjs")) {
    fail("app.asar does not contain the Desktop WebSocket runtime.");
  }
  const violations = entries
    .filter(sensitivePackagedPath)
    .map((path) => `app.asar/${path}: forbidden runtime-data path`);
  const extractionRoot = await mkdtemp(join(tmpdir(), "codex-collab-asar-"));
  try {
    asar.extractAll(asarPath, extractionRoot);
    violations.push(...(await inspectExtractedTree(extractionRoot, "app.asar")));
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
  return violations;
}

async function inspectPackagedApplication(releaseRoot) {
  const resources = join(releaseRoot, "win-unpacked", "resources");
  const asarPath = join(resources, "app.asar");
  if (!(await exists(asarPath))) fail(`missing ${relative(releaseRoot, asarPath)}.`);
  const hostRoot = join(resources, "host");
  const workerPath = join(hostRoot, "dist", "workspace-sync-worker.js");
  const protocolPath = join(
    hostRoot,
    "node_modules",
    "@codex-collab",
    "protocol",
    "dist",
    "index.js",
  );
  if (!(await exists(workerPath))) fail("missing shared Host worker entrypoint.");
  if (!(await exists(protocolPath))) fail("missing staged Host protocol runtime.");
  const brokerPath = join(resources, "native", "codex-collab-host-ipc.exe");
  if (!(await exists(brokerPath))) {
    fail("missing resources/native/codex-collab-host-ipc.exe.");
  }
  const violations = await inspectAsar(asarPath);
  violations.push(...(await inspectExtractedTree(hostRoot, "resources/host")));
  const unpacked = `${asarPath}.unpacked`;
  if (await exists(unpacked)) {
    violations.push(...(await inspectExtractedTree(unpacked, "app.asar.unpacked")));
  }
  if (violations.length > 0) {
    fail(`private material found:\n- ${violations.join("\n- ")}`);
  }
}

async function releaseArtifacts(releaseRoot) {
  const topLevel = (await readdir(releaseRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
    .map((entry) => join(releaseRoot, entry.name));
  if (topLevel.length < 1) fail("no top-level NSIS installer was produced.");
  const unpackedExecutables = (await filesUnder(join(releaseRoot, "win-unpacked"))).filter(
    (path) => path.toLowerCase().endsWith(".exe") && !path.includes("resources\\"),
  );
  const paths = [...topLevel, ...unpackedExecutables];
  return Promise.all(
    paths.map(async (path) => ({
      file: normalizePath(relative(releaseRoot, path)),
      bytes: (await stat(path)).size,
      sha256: await sha256(path),
    })),
  );
}

async function writeReleaseMetadata(releaseRoot, packageJson, versions) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) fail("run artifact metadata generation through npm.");
  const sbomText = execFileSync(
    process.execPath,
    [
      npmCli,
      "sbom",
      "--workspace",
      "@codex-collab/desktop",
      "--omit=dev",
      "--sbom-format",
      "spdx",
    ],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const sbom = JSON.parse(sbomText);
  if (sbom.spdxVersion !== "SPDX-2.3") fail("npm produced an unexpected SBOM format.");
  const sbomPath = join(releaseRoot, SBOM_NAME);
  await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");

  const artifacts = await releaseArtifacts(releaseRoot);
  const checksumText = `${artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.file}`)
    .join("\n")}\n`;
  await writeFile(join(releaseRoot, CHECKSUM_NAME), checksumText, "utf8");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const manifest = {
    schemaVersion: 1,
    product: "Codex Collab Windows Owner Desktop Internal Beta",
    version: packageJson.version,
    buildId: `${packageJson.version}+${commit.slice(0, 12)}`,
    commit,
    protocols: versions,
    runtime: {
      electron: EXPECTED_ELECTRON,
      electronBuilder: EXPECTED_BUILDER,
      platform: "win32",
      architecture: "x64",
      installer: "nsis-per-user",
      signed: false,
      autoUpdate: false,
    },
    sbom: {
      file: SBOM_NAME,
      sha256: await sha256(sbomPath),
    },
    artifacts,
  };
  await writeFile(
    join(releaseRoot, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function validateReleaseMetadata(releaseRoot, packageJson, versions) {
  const manifest = await readJson(join(releaseRoot, MANIFEST_NAME));
  const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  if (manifest.version !== packageJson.version || manifest.commit !== currentCommit) {
    fail("build manifest version or commit does not match the current source checkout.");
  }
  if (JSON.stringify(manifest.protocols) !== JSON.stringify(versions)) {
    fail("build manifest protocol versions do not match source constants.");
  }
  if (
    manifest.runtime?.electron !== EXPECTED_ELECTRON ||
    manifest.runtime?.electronBuilder !== EXPECTED_BUILDER ||
    manifest.runtime?.installer !== "nsis-per-user" ||
    manifest.runtime?.signed !== false ||
    manifest.runtime?.autoUpdate !== false
  ) {
    fail("build manifest runtime policy is invalid.");
  }
  const sbomPath = join(releaseRoot, manifest.sbom?.file ?? "");
  const sbom = await readJson(sbomPath);
  if (sbom.spdxVersion !== "SPDX-2.3" || (await sha256(sbomPath)) !== manifest.sbom.sha256) {
    fail("SBOM is missing, invalid or does not match its recorded SHA-256.");
  }
  const checksumLines = (await readFile(join(releaseRoot, CHECKSUM_NAME), "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const expectedLines = [];
  for (const artifact of manifest.artifacts ?? []) {
    const path = resolve(releaseRoot, artifact.file);
    if (!normalizePath(relative(releaseRoot, path)).startsWith("..") && (await exists(path))) {
      const digest = await sha256(path);
      const bytes = (await stat(path)).size;
      if (digest !== artifact.sha256 || bytes !== artifact.bytes) {
        fail(`${artifact.file} does not match the build manifest.`);
      }
      expectedLines.push(`${digest}  ${artifact.file}`);
      continue;
    }
    fail(`manifest artifact is missing or outside the release directory: ${artifact.file}`);
  }
  if (expectedLines.join("\n") !== checksumLines.join("\n")) {
    fail("SHA256SUMS does not match the build manifest.");
  }
}

export async function runDesktopArtifactVerification(arguments_ = []) {
  const sourceOnly = arguments_.includes("--source-only");
  const unpackedOnly = arguments_.includes("--unpacked-only");
  const write = arguments_.includes("--write");
  const releaseArgument = arguments_.find((argument) => argument.startsWith("--release-root="));
  const releaseRoot = releaseArgument
    ? resolve(repositoryRoot, releaseArgument.slice("--release-root=".length))
    : defaultReleaseRoot;
  const packageJson = await validatePinnedToolchain();
  const versions = await protocolVersions();
  if (sourceOnly) {
    console.log("Desktop source and lockfile pins verified.");
    return;
  }
  await inspectPackagedApplication(releaseRoot);
  if (unpackedOnly) {
    console.log("Desktop unpacked application verified.");
    return;
  }
  if (write) await writeReleaseMetadata(releaseRoot, packageJson, versions);
  await validateReleaseMetadata(releaseRoot, packageJson, versions);
  console.log("Desktop installer, ASAR, SBOM, manifest and SHA-256 verified.");
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  runDesktopArtifactVerification(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
