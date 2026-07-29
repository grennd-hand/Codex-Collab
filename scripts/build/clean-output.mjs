import { rm } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

const requested = process.argv[2];
if (!requested) throw new Error("A generated output directory is required.");

const workspaceRoot = resolve(".");
const target = resolve(workspaceRoot, requested);
const targetRelative = relative(workspaceRoot, target);
if (
  targetRelative.length === 0 ||
  targetRelative.startsWith("..") ||
  basename(target) !== "dist"
) {
  throw new Error(`Refusing to clean non-dist path: ${target}`);
}

await rm(target, { recursive: true, force: true });
