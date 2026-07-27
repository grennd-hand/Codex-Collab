import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export function resolveCodexExecutable(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const output = execFileSync(locator, ["codex"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const executable = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!executable) throw new Error("Codex CLI executable was not found on PATH");
  return executable;
}

export class CodexAppServerProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;

  start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(resolveCodexExecutable(), ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.emit("diagnostic", text);
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.emit("exit", code, signal);
    });
    return child;
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}
