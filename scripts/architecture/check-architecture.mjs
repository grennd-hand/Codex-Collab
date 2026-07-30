import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const dashboardRoot = path.join(repositoryRoot, "apps", "dashboard", "src");
const desktopRoot = path.join(repositoryRoot, "apps", "desktop", "src");
const desktopRendererRoot = path.join(
  repositoryRoot,
  "apps",
  "desktop",
  "renderer",
);
const pluginRoot = path.join(
  repositoryRoot,
  "plugins",
  "codex-collab",
  "src",
);
const relayRoot = path.join(repositoryRoot, "apps", "relay", "src");
const scriptsRoot = path.join(repositoryRoot, "scripts");
const docsRoot = path.join(repositoryRoot, "docs");
const failures = [];

const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".cts",
  ".js",
  ".mjs",
  ".css",
  ".rs",
]);

const legacySizeDebt = new Map();

const dashboardRootAllowlist = new Set([
  "App.test.ts",
  "App.tsx",
  "main.tsx",
  "styles.css",
  "vite-env.d.ts",
]);

const desktopRootAllowlist = new Set(["main.ts", "preload.cts"]);
const desktopRendererRootAllowlist = new Set(["index.html", "main.tsx"]);
const relayRootAllowlist = new Set(["server.ts"]);
const scriptsRootAllowlist = new Set();
const docsRootAllowlist = new Set(["README.md"]);
const repositoryRootAllowlist = new Set([
  ".codex-collabignore",
  ".dockerignore",
  ".gitignore",
  "AGENTS.md",
  "docker-compose.yml",
  "package-lock.json",
  "package.json",
  "README.md",
  "skills-lock.json",
  "tsconfig.base.json",
]);

const pluginRootAllowlist = new Set([
  "mcp-server.ts",
  "workspace-sync-worker.ts",
]);

const guardedFiles = new Map([
  ["apps/dashboard/src/App.tsx", 600],
  ["apps/dashboard/src/app/DashboardController.tsx", 400],
  ["apps/dashboard/src/features/workspace/useWorkspaceHistoryController.ts", 400],
  ["apps/dashboard/src/app/shell/AppHeader.tsx", 200],
  ["apps/dashboard/src/features/activity/ActivityPanel.tsx", 100],
  ["apps/dashboard/src/features/collaboration/CollaborationPanel.tsx", 350],
  ["apps/dashboard/src/features/collaboration/MembersPanel.tsx", 200],
  ["apps/relay/src/workspace/workspace-history-pagination.ts", 200],
  ["plugins/codex-collab/src/host/host-runtime.ts", 350],
  ["plugins/codex-collab/src/host/host-runtime-lock.ts", 100],
  ["plugins/codex-collab/src/host/host-application.ts", 100],
  ["plugins/codex-collab/src/host/host-session-service.ts", 300],
  ["plugins/codex-collab/src/host/host-workspace-service.ts", 350],
  ["plugins/codex-collab/src/mcp-server.ts", 100],
  ["plugins/codex-collab/src/workspace-sync-worker.ts", 80],
]);

const styleModules = [
  "apps/dashboard/src/styles/foundation.css",
  "apps/dashboard/src/features/collaboration/collaboration.css",
  "apps/dashboard/src/features/timeline/styles/timeline.css",
  "apps/dashboard/src/features/composer/composer.css",
  "apps/dashboard/src/features/activity/activity.css",
  "apps/dashboard/src/features/dialogs/styles/dialogs.css",
  "apps/dashboard/src/features/dialogs/styles/setup-dialog.css",
  "apps/dashboard/src/styles/responsive.css",
];

const styleFacades = new Map([
  [
    "apps/dashboard/src/styles/responsive.css",
    [
      '@import "./shell-responsive.css";',
      '@import "../layout/workspace/workspace-responsive.css";',
      '@import "../features/collaboration/collaboration-responsive.css";',
      '@import "../features/timeline/styles/timeline-responsive.css";',
      '@import "../features/composer/composer-responsive.css";',
      '@import "../features/dialogs/styles/dialogs-responsive.css";',
      '@import "./reduced-motion.css";',
    ],
  ],
  [
    "apps/dashboard/src/features/timeline/styles/timeline.css",
    [
      '@import "./timeline-messages.css";',
      '@import "./timeline-execution.css";',
      '@import "./timeline-execution-stream.css";',
      '@import "./timeline-completion.css";',
      '@import "./timeline-content.css";',
    ],
  ],
  [
    "apps/dashboard/src/ide/shell/ide-workspace.css",
    [
      '@import "../explorer/ide-shell-explorer.css";',
      '@import "../editor/ide-editor.css";',
      '@import "./ide-responsive.css";',
    ],
  ],
  [
    "apps/desktop/renderer/styles/desktop.css",
    [
      '@import "../app/desktop-app.css";',
      '@import "../shell/desktop-shell.css";',
      '@import "../panes/desktop-panes.css";',
    ],
  ],
]);

function sourceLineCount(relativePath) {
  const content = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
  return content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0);
}

function checkDashboardRoot() {
  const files = fs
    .readdirSync(dashboardRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  for (const file of files) {
    if (!dashboardRootAllowlist.has(file)) {
      failures.push(
        `Dashboard root file ${file} must be classified under app/, features/, ide/, layout/, shared/, or styles/.`,
      );
    }
  }
}

function checkRootAllowlist(directory, allowlist, label) {
  const files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  for (const file of files) {
    if (!allowlist.has(file)) {
      failures.push(`${label}/${file} must be classified under a responsibility directory.`);
    }
  }
}

function checkMarkdownLinks() {
  const markdownFiles = [
    path.join(repositoryRoot, "README.md"),
    ...walk(docsRoot).filter((file) => file.endsWith(".md")),
  ];
  for (const markdownFile of markdownFiles) {
    const source = fs.readFileSync(markdownFile, "utf8");
    for (const match of source.matchAll(/\]\(([^)#?]+\.md)(?:#[^)]*)?\)/g)) {
      const target = path.resolve(path.dirname(markdownFile), match[1]);
      if (!fs.existsSync(target)) {
        failures.push(
          `${normalizedRelativePath(markdownFile)} links to missing Markdown file ${match[1]}.`,
        );
      }
    }
  }
}

function checkTrackedRepositoryRoot() {
  const trackedRootFiles = execFileSync("git", ["ls-files"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter((file) => file.length > 0 && !file.includes("/"));
  for (const file of trackedRootFiles) {
    if (!repositoryRootAllowlist.has(file)) {
      failures.push(
        `${file} is a tracked repository-root file without an architecture classification.`,
      );
    }
  }
}

function checkPluginRoot() {
  const files = fs
    .readdirSync(pluginRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  for (const file of files) {
    if (!pluginRootAllowlist.has(file)) {
      failures.push(
        `plugins/codex-collab/src/${file} must live in a domain directory; only process entrypoints may remain at the plugin source root.`,
      );
    }
  }
}

function checkGuardedFiles() {
  for (const [relativePath, maximumLines] of guardedFiles) {
    const lines = sourceLineCount(relativePath);
    if (lines > maximumLines) {
      failures.push(
        `${relativePath} has ${lines} lines (growth ceiling ${maximumLines}); extract a cohesive module before adding more.`,
      );
    }
  }
}

function normalizedRelativePath(absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}

function defaultSourceLimit(relativePath) {
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath)) return 700;
  if (relativePath.endsWith(".css")) return 500;
  if (relativePath.startsWith("scripts/") && relativePath.endsWith(".mjs")) {
    return 600;
  }
  if (relativePath.endsWith(".tsx")) return 300;
  if (/\/(?:routes?)\//.test(relativePath)) return 350;
  if (/(?:^|\/)use[A-Z][^/]*Controller\.[cm]?[jt]sx?$/.test(relativePath)) {
    return 400;
  }
  if (/\/(?:hooks?|controllers?)\//.test(relativePath)) return 400;
  if (/(?:^|\/)(?:server|main|index)\.[cm]?[jt]s$/.test(relativePath)) return 600;
  return 500;
}

function checkSourceSizes() {
  const roots = ["apps", "packages", "plugins", "scripts", "native/host-ipc/src"]
    .map((directory) => path.join(repositoryRoot, directory))
    .filter((directory) => fs.existsSync(directory));
  for (const root of roots) {
    for (const absolutePath of walk(root)) {
      const relativePath = normalizedRelativePath(absolutePath);
      if (relativePath.startsWith("apps/relay/public/")) continue;
      if (relativePath.includes("/node_modules/") || relativePath.includes("/dist/")) {
        continue;
      }
      if (!sourceExtensions.has(path.extname(absolutePath))) continue;
      const maximumLines =
        guardedFiles.get(relativePath) ??
        legacySizeDebt.get(relativePath) ??
        defaultSourceLimit(relativePath);
      const lines = sourceLineCount(relativePath);
      if (lines > maximumLines) {
        failures.push(
          `${relativePath} has ${lines} lines (limit ${maximumLines}); split by responsibility instead of adding another concern.`,
        );
      }
    }
  }
}

function checkStyles() {
  const facade = fs
    .readFileSync(path.join(dashboardRoot, "styles.css"), "utf8")
    .trim()
    .split(/\r?\n/);
  const expected = styleModules.map(
    (relativePath) =>
      `@import "./${path.relative(dashboardRoot, path.join(repositoryRoot, relativePath)).split(path.sep).join("/")}";`,
  );
  if (JSON.stringify(facade) !== JSON.stringify(expected)) {
    failures.push(
      "apps/dashboard/src/styles.css must remain an ordered import-only facade.",
    );
  }
  for (const [relativePath, expectedImports] of styleFacades) {
    const actualImports = fs
      .readFileSync(path.join(repositoryRoot, relativePath), "utf8")
      .trim()
      .split(/\r?\n/);
    if (JSON.stringify(actualImports) !== JSON.stringify(expectedImports)) {
      failures.push(`${relativePath} must remain an ordered import-only facade.`);
    }
  }
  for (const relativePath of styleModules) {
    const lines = sourceLineCount(relativePath);
    if (lines > 1_000) {
      failures.push(
        `${relativePath} has ${lines} lines; split it by interaction domain before it grows further.`,
      );
    }
  }
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolutePath) : [absolutePath];
  });
}

function checkSharedImports() {
  const sharedRoot = path.join(dashboardRoot, "shared");
  for (const absolutePath of walk(sharedRoot)) {
    if (!/\.(?:ts|tsx)$/.test(absolutePath)) continue;
    const source = fs.readFileSync(absolutePath, "utf8");
    if (/from\s+["'][^"']*(?:features|app|ide|layout)\//.test(source)) {
      failures.push(
        `${path.relative(repositoryRoot, absolutePath)} imports a higher dashboard layer; shared/ must stay dependency-free from product features.`,
      );
    }
  }
}

function checkDesktopBoundaries() {
  for (const absolutePath of walk(dashboardRoot)) {
    if (!/\.(?:ts|tsx)$/.test(absolutePath)) continue;
    const source = fs.readFileSync(absolutePath, "utf8");
    const relativePath = normalizedRelativePath(absolutePath);
    if (/from\s+["']electron["']|require\s*\(\s*["']electron["']/.test(source)) {
      failures.push(`${relativePath} cannot import Electron into the Dashboard renderer.`);
    }
    if (/apps[\\/]desktop|\.\.[\\/].*desktop/.test(source)) {
      failures.push(`${relativePath} cannot import the Desktop application layer.`);
    }
    if (
      relativePath !== "apps/dashboard/src/shared/runtime/browser-runtime.ts" &&
      (/\bfetch\s*\(/.test(source) || /new\s+WebSocket\s*\(/.test(source))
    ) {
      failures.push(
        `${relativePath} performs renderer network I/O outside browser-runtime.ts.`,
      );
    }
  }

  const preloadPath = path.join(desktopRoot, "preload.cts");
  const preload = fs.readFileSync(preloadPath, "utf8");
  const preloadImports = [...preload.matchAll(/(?:from\s+|require\s*\(\s*)["']([^"']+)/g)];
  for (const match of preloadImports) {
    if (match[1] !== "electron" && match[1] !== "./ipc/ipc-contract.js") {
      failures.push(`apps/desktop/src/preload.cts imports disallowed module ${match[1]}.`);
    }
  }
  if (!/import\s+type\s*\{[\s\S]*?\}\s*from\s*["']\.\/ipc\/ipc-contract\.js["']/.test(preload)) {
    failures.push("apps/desktop/src/preload.cts must consume its local contract as a type-only import.");
  }

  for (const absolutePath of walk(desktopRoot)) {
    if (!/\.(?:ts|cts)$/.test(absolutePath)) continue;
    const source = fs.readFileSync(absolutePath, "utf8");
    const relativePath = normalizedRelativePath(absolutePath);
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1].replaceAll("\\", "/").toLowerCase(),
    );
    for (const specifier of imports) {
      if (
        specifier.includes("apps/relay") ||
        specifier.includes("/relay/src/") ||
        specifier.includes("session-store") ||
        specifier.includes("sqlite-session") ||
        specifier.includes("docker-compose") ||
        specifier.includes("caddyfile") ||
        specifier.includes("/deploy/")
      ) {
        failures.push(
          `${relativePath} imports Relay storage/server or deployment implementation ${specifier}.`,
        );
      }
    }
  }

  for (const absolutePath of walk(desktopRendererRoot)) {
    if (!/\.(?:ts|tsx)$/.test(absolutePath)) continue;
    const source = fs.readFileSync(absolutePath, "utf8");
    const relativePath = normalizedRelativePath(absolutePath);
    if (/from\s+["']electron["']|require\s*\(\s*["']electron["']/.test(source)) {
      failures.push(`${relativePath} cannot import Electron into the renderer.`);
    }
    if (/\bfetch\s*\(|new\s+WebSocket\s*\(/.test(source)) {
      failures.push(`${relativePath} cannot perform direct renderer network I/O.`);
    }
    if (
      /from\s+["'][^"']*dashboard[\\/]src[\\/](?:App|app[\\/]DashboardView|app[\\/]DashboardWorkspaceView)(?:\.js)?["']/.test(
        source,
      )
    ) {
      failures.push(
        `${relativePath} imports the browser Dashboard page instead of desktop-safe controllers and features.`,
      );
    }
  }

  const desktopViteConfig = fs.readFileSync(
    path.join(repositoryRoot, "apps", "desktop", "vite.config.ts"),
    "utf8",
  );
  if (/new URL\(["']\.\.\/dashboard["']/.test(desktopViteConfig)) {
    failures.push(
      "apps/desktop/vite.config.ts must use the dedicated desktop renderer root.",
    );
  }
}

function checkMcpFacade() {
  const relativePath = "plugins/codex-collab/src/mcp-server.ts";
  const source = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
  const forbiddenImports = [
    "app-server-client",
    "local-profile",
    "relay-client",
    "workspace-roots",
    "workspace-sync-service",
  ];
  for (const moduleName of forbiddenImports) {
    if (source.includes(moduleName)) {
      failures.push(
        `${relativePath} must remain a protocol facade and cannot import privileged Host module ${moduleName}.`,
      );
    }
  }
}

checkDashboardRoot();
checkRootAllowlist(desktopRoot, desktopRootAllowlist, "apps/desktop/src");
checkRootAllowlist(
  desktopRendererRoot,
  desktopRendererRootAllowlist,
  "apps/desktop/renderer",
);
checkRootAllowlist(relayRoot, relayRootAllowlist, "apps/relay/src");
checkRootAllowlist(scriptsRoot, scriptsRootAllowlist, "scripts");
checkRootAllowlist(docsRoot, docsRootAllowlist, "docs");
checkTrackedRepositoryRoot();
checkMarkdownLinks();
checkPluginRoot();
checkGuardedFiles();
checkSourceSizes();
checkStyles();
checkSharedImports();
checkMcpFacade();
checkDesktopBoundaries();

if (failures.length > 0) {
  console.error("Architecture validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Architecture validation passed: ${guardedFiles.size} focused ceilings, ${legacySizeDebt.size} shrinking legacy ceilings, repository source budgets enforced.`,
);
