import { spawn } from "node:child_process";
import { WINDOWS_CAS_NATIVE_SOURCE } from "./windows-file-cas-native-source.js";
import { WINDOWS_ENTRY_RENAME_SOURCE } from "./windows-entry-rename-source.js";

export interface WindowsEntryRenameRequest {
  root: string;
  source: string;
  destinationParent: string;
  destination: string;
  expectedSha256: string | null;
  isDirectory: boolean;
}

export interface WindowsEntryRenameResult {
  status: "committed" | "conflict" | "failed";
  message: string;
}

const SOURCE = [WINDOWS_CAS_NATIVE_SOURCE, WINDOWS_ENTRY_RENAME_SOURCE].join("\n");
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_COLLAB_RENAME_REQUEST))",
  "$request = $json | ConvertFrom-Json",
  `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(SOURCE, "utf8").toString("base64")}'))`,
  "Add-Type -TypeDefinition $source -Language CSharp | Out-Null",
  "$result = [CodexCollabAtomicWrite.WindowsCas]::RenameEntry([string]$request.root, [string]$request.source, [string]$request.destinationParent, [string]$request.destination, [string]$request.expectedSha256, [bool]$request.isDirectory)",
  "$result | ConvertTo-Json -Compress",
].join("; ");

export function runWindowsEntryRename(
  request: WindowsEntryRenameRequest,
): Promise<WindowsEntryRenameResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
      {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_COLLAB_RENAME_REQUEST: Buffer.from(
            JSON.stringify(request),
            "utf8",
          ).toString("base64"),
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-8_000); });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Windows guarded rename helper failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim()) as { Status: WindowsEntryRenameResult["status"]; Message: string };
        resolve({ status: result.Status, message: result.Message });
      } catch (error) {
        reject(new Error(`Windows guarded rename helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(SCRIPT);
  });
}
