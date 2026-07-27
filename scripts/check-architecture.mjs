import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const dashboardRoot = path.join(repositoryRoot, "apps", "dashboard", "src");
const failures = [];

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".css"]);

const legacySizeDebt = new Map();

const dashboardRootAllowlist = new Set([
  "App.test.ts",
  "App.tsx",
  "main.tsx",
  "styles.css",
  "vite-env.d.ts",
]);

const guardedFiles = new Map([
  ["apps/dashboard/src/App.tsx", 600],
  ["apps/dashboard/src/app/shell/AppHeader.tsx", 200],
  ["apps/dashboard/src/features/activity/ActivityPanel.tsx", 100],
  ["apps/dashboard/src/features/collaboration/CollaborationPanel.tsx", 350],
  ["apps/dashboard/src/features/collaboration/MembersPanel.tsx", 200],
  ["apps/relay/src/workspace/workspace-history-pagination.ts", 200],
]);

const styleModules = [
  "foundation.css",
  "collaboration.css",
  "timeline.css",
  "composer.css",
  "activity.css",
  "dialogs.css",
  "responsive.css",
];

const styleFacades = new Map([
  [
    "apps/dashboard/src/styles/timeline.css",
    [
      '@import "./timeline-messages.css";',
      '@import "./timeline-execution.css";',
      '@import "./timeline-content.css";',
    ],
  ],
  [
    "apps/dashboard/src/ide/ide-workspace.css",
    [
      '@import "./ide-shell-explorer.css";',
      '@import "./ide-editor.css";',
      '@import "./ide-responsive.css";',
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
  if (/\/(?:hooks?|controllers?)\//.test(relativePath)) return 400;
  if (/(?:^|\/)(?:server|main|index)\.[cm]?[jt]s$/.test(relativePath)) return 600;
  return 500;
}

function checkSourceSizes() {
  const roots = ["apps", "packages", "plugins", "scripts"]
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
    (name) => `@import "./styles/${name}";`,
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
  for (const name of styleModules) {
    const relativePath = `apps/dashboard/src/styles/${name}`;
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

checkDashboardRoot();
checkGuardedFiles();
checkSourceSizes();
checkStyles();
checkSharedImports();

if (failures.length > 0) {
  console.error("Architecture validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Architecture validation passed: ${guardedFiles.size} focused ceilings, ${legacySizeDebt.size} shrinking legacy ceilings, repository source budgets enforced.`,
);
