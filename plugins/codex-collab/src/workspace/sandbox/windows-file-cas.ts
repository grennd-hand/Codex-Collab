import { spawn } from "node:child_process";
import { WINDOWS_CAS_NATIVE_SOURCE } from "./windows-file-cas-native-source.js";
import { WINDOWS_CAS_TRANSACTION_SOURCE } from "./windows-file-cas-transaction-source.js";

export interface WindowsFileCasDebugOptions {
  guardSignalPath?: string;
  guardContinuePath?: string;
  targetMovedSignalPath?: string;
  publishContinuePath?: string;
  failMetadataAfterPublish?: boolean;
}

export interface WindowsFileCasRequest {
  root: string;
  target: string;
  candidate: string;
  recovery: string;
  journal: string;
  transactionId: string;
  targetRelativePath: string;
  expectedSha256?: string;
  requestedSha256: string;
  debug?: WindowsFileCasDebugOptions;
}

export interface WindowsFileCasResult {
  status: "committed" | "conflict" | "failed";
  phase: string;
  message: string;
  targetMoved: boolean;
  candidateMoved: boolean;
  modifiedAt?: string;
  metadataWarning?: string;
}

/*
 * This helper deliberately runs the whole compare-and-swap inside one native
 * process. Both file handles deny write/delete sharing from the moment their
 * hashes are observed until the final no-replace rename completes.
 *
 * Windows PowerShell is used instead of an in-process Node native add-on so a
 * packaged plugin does not need an architecture-specific binary. Add-Type
 * compiles this small P/Invoke helper in the child process.
 */
const WINDOWS_CAS_SOURCE = [
  WINDOWS_CAS_NATIVE_SOURCE,
  WINDOWS_CAS_TRANSACTION_SOURCE,
].join("\n");

const POWERSHELL_CAS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_COLLAB_CAS_REQUEST))",
  "$request = $requestJson | ConvertFrom-Json",
  `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(
    WINDOWS_CAS_SOURCE,
    "utf8",
  ).toString("base64")}'))`,
  "Add-Type -TypeDefinition $source -Language CSharp | Out-Null",
  "$debug = $request.debug",
  "$result = [CodexCollabAtomicWrite.WindowsCas]::Execute([string]$request.root, [string]$request.target, [string]$request.candidate, [string]$request.recovery, [string]$request.journal, [string]$request.transactionId, [string]$request.targetRelativePath, $(if ($null -eq $request.expectedSha256) { $null } else { [string]$request.expectedSha256 }), [string]$request.requestedSha256, [string]$debug.guardSignalPath, [string]$debug.guardContinuePath, [string]$debug.targetMovedSignalPath, [string]$debug.publishContinuePath, [bool]$debug.failMetadataAfterPublish)",
  "$result | ConvertTo-Json -Compress -Depth 4",
].join("; ");

export function runWindowsFileCas(
  request: WindowsFileCasRequest,
): Promise<WindowsFileCasResult> {
  return new Promise((resolve, reject) => {
    const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString(
      "base64",
    );
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "-",
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CODEX_COLLAB_CAS_REQUEST: encodedRequest },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-32_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Windows guarded CAS helper failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as {
          Status: WindowsFileCasResult["status"];
          Phase: string;
          Message: string;
          TargetMoved: boolean;
          CandidateMoved: boolean;
          ModifiedAt?: string;
          MetadataWarning?: string;
        };
        resolve({
          status: parsed.Status,
          phase: parsed.Phase,
          message: parsed.Message,
          targetMoved: parsed.TargetMoved,
          candidateMoved: parsed.CandidateMoved,
          ...(parsed.ModifiedAt ? { modifiedAt: parsed.ModifiedAt } : {}),
          ...(parsed.MetadataWarning
            ? { metadataWarning: parsed.MetadataWarning }
            : {}),
        });
      } catch (error) {
        reject(
          new Error(
            `Windows guarded CAS helper returned invalid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });
    child.stdin.end(POWERSHELL_CAS_SCRIPT);
  });
}
