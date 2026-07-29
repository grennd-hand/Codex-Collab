import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const validator = process.env.CODEX_COLLAB_PLUGIN_VALIDATOR ?? join(
  homedir(),
  ".codex",
  "skills",
  ".system",
  "plugin-creator",
  "scripts",
  "validate_plugin.py",
);

if (!existsSync(validator)) {
  throw new Error(
    "Plugin validator was not found. Set CODEX_COLLAB_PLUGIN_VALIDATOR to validate_plugin.py.",
  );
}

const result = spawnSync(
  "python",
  [validator, join(repositoryRoot, "plugins", "codex-collab")],
  { cwd: repositoryRoot, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
