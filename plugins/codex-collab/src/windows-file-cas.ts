import { spawn } from "node:child_process";

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
const WINDOWS_CAS_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace CodexCollabAtomicWrite
{
    public sealed class CasResult
    {
        public string Status { get; set; }
        public string Phase { get; set; }
        public string Message { get; set; }
        public bool TargetMoved { get; set; }
        public bool CandidateMoved { get; set; }
        public string ModifiedAt { get; set; }
        public string MetadataWarning { get; set; }
    }

    public static class WindowsCas
    {
        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint DELETE = 0x00010000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const uint CREATE_NEW = 1;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const int FileRenameInfo = 3;
        private const int ERROR_FILE_NOT_FOUND = 2;
        private const int ERROR_PATH_NOT_FOUND = 3;
        private const int ERROR_ACCESS_DENIED = 5;
        private const int ERROR_SHARING_VIOLATION = 32;
        private const int ERROR_FILE_EXISTS = 80;
        private const int ERROR_ALREADY_EXISTS = 183;
        private const uint FILE_TYPE_DISK = 1;

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            public uint LowDateTime;
            public uint HighDateTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            public uint FileAttributes;
            public FILETIME CreationTime;
            public FILETIME LastAccessTime;
            public FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle file,
            out BY_HANDLE_FILE_INFORMATION information);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetFileType(SafeFileHandle file);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            SafeFileHandle file,
            StringBuilder path,
            uint pathLength,
            uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ReadFile(
            SafeFileHandle file,
            byte[] buffer,
            uint bytesToRead,
            out uint bytesRead,
            IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFilePointerEx(
            SafeFileHandle file,
            long distance,
            out long newPointer,
            uint moveMethod);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFileInformationByHandle(
            SafeFileHandle file,
            int fileInformationClass,
            IntPtr fileInformation,
            uint bufferSize);

        private static Win32Exception LastError(string operation)
        {
            int code = Marshal.GetLastWin32Error();
            return new Win32Exception(code, operation + " (Win32 " + code.ToString() + ")");
        }

        private static SafeFileHandle OpenGuardedFile(string path, string canonicalRoot)
        {
            SafeFileHandle handle = CreateFileW(
                path,
                GENERIC_READ | DELETE,
                FILE_SHARE_READ,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(code, "Cannot acquire the guarded file handle");
            }
            ValidateRegularFile(handle, path);
            ValidateInsideRoot(handle, canonicalRoot);
            return handle;
        }

        private static SafeFileHandle OpenGuardedDirectory(string path, string canonicalRoot)
        {
            SafeFileHandle handle = CreateFileW(
                path,
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(code, "Cannot acquire the guarded directory handle");
            }
            BY_HANDLE_FILE_INFORMATION information = Information(handle);
            if ((information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
            {
                handle.Dispose();
                throw new IOException("A guarded transaction directory is a reparse point");
            }
            ValidateInsideRoot(handle, canonicalRoot);
            return handle;
        }

        private static void ValidateInsideRoot(SafeFileHandle handle, string canonicalRoot)
        {
            StringBuilder path = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 0);
            if (length == 0 || length >= path.Capacity)
                throw LastError("Cannot resolve the guarded handle path");
            string resolved = path.ToString();
            if (resolved.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase))
                resolved = "\\\\" + resolved.Substring(8);
            else if (resolved.StartsWith("\\\\?\\", StringComparison.OrdinalIgnoreCase))
                resolved = resolved.Substring(4);
            resolved = Path.GetFullPath(resolved).TrimEnd(Path.DirectorySeparatorChar);
            string root = Path.GetFullPath(canonicalRoot).TrimEnd(Path.DirectorySeparatorChar);
            if (!resolved.Equals(root, StringComparison.OrdinalIgnoreCase) &&
                !resolved.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new IOException("A guarded handle resolves outside the approved root");
        }

        private static BY_HANDLE_FILE_INFORMATION Information(SafeFileHandle handle)
        {
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
            {
                throw LastError("GetFileInformationByHandle failed");
            }
            return information;
        }

        private static void ValidateRegularFile(SafeFileHandle handle, string path)
        {
            BY_HANDLE_FILE_INFORMATION information = Information(handle);
            if ((information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
            {
                handle.Dispose();
                throw new IOException("A guarded transaction file is a reparse point: " + path);
            }
            if (GetFileType(handle) != FILE_TYPE_DISK)
            {
                handle.Dispose();
                throw new IOException("A guarded transaction path is not a disk file: " + path);
            }
        }

        private static string HashHandle(SafeFileHandle handle)
        {
            long ignored;
            if (!SetFilePointerEx(handle, 0, out ignored, 0))
            {
                throw LastError("Cannot seek the guarded file handle");
            }
            using (SHA256 hash = SHA256.Create())
            {
                byte[] buffer = new byte[64 * 1024];
                while (true)
                {
                    uint read;
                    if (!ReadFile(handle, buffer, (uint)buffer.Length, out read, IntPtr.Zero))
                    {
                        throw LastError("Cannot hash the guarded file handle");
                    }
                    if (read == 0) break;
                    hash.TransformBlock(buffer, 0, (int)read, null, 0);
                }
                hash.TransformFinalBlock(new byte[0], 0, 0);
                if (!SetFilePointerEx(handle, 0, out ignored, 0))
                {
                    throw LastError("Cannot rewind the guarded file handle");
                }
                StringBuilder output = new StringBuilder(64);
                foreach (byte value in hash.Hash)
                {
                    output.Append(value.ToString("x2"));
                }
                return output.ToString();
            }
        }

        private static void EnsureSameVolume(
            SafeFileHandle candidate,
            SafeFileHandle targetParent,
            SafeFileHandle recoveryDirectory,
            SafeFileHandle journalDirectory,
            SafeFileHandle target)
        {
            uint volume = Information(candidate).VolumeSerialNumber;
            if (Information(targetParent).VolumeSerialNumber != volume ||
                Information(recoveryDirectory).VolumeSerialNumber != volume ||
                Information(journalDirectory).VolumeSerialNumber != volume ||
                (target != null && Information(target).VolumeSerialNumber != volume))
            {
                throw new IOException("All CAS transaction files must be on the target volume");
            }
        }

        private static void RenameNoReplace(
            SafeFileHandle source,
            SafeFileHandle destinationDirectory,
            string destinationPath)
        {
            // For local files Windows requires an absolute name with a null
            // RootDirectory. The separately held directory handle still pins
            // the validated non-reparse destination directory against rename.
            byte[] name = Encoding.Unicode.GetBytes(destinationPath);
            int nameOffset = IntPtr.Size == 8 ? 20 : 12;
            // FILE_RENAME_INFO has a trailing WCHAR[1]. Keep an explicit zero
            // terminator in-bounds even though FileNameLength excludes it.
            int size = nameOffset + name.Length + 2;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
                Marshal.WriteByte(buffer, 0, 0); // ReplaceIfExists = FALSE
                Marshal.WriteIntPtr(buffer, IntPtr.Size == 8 ? 8 : 4, IntPtr.Zero);
                Marshal.WriteInt32(buffer, IntPtr.Size == 8 ? 16 : 8, name.Length);
                Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
                if (!SetFileInformationByHandle(source, FileRenameInfo, buffer, (uint)size))
                {
                    throw LastError("The guarded no-replace rename failed");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static string JsonEscape(string value)
        {
            if (value == null) return "";
            return value.Replace("\\", "\\\\").Replace("\"", "\\\"")
                .Replace("\r", "\\r").Replace("\n", "\\n");
        }

        private static string JournalRecord(
            string targetRelativePath,
            string expected,
            string requested,
            string phase,
            string transactionId,
            string detail)
        {
            return "{\"target\":\"" + JsonEscape(targetRelativePath) +
                "\",\"expectedSha256\":\"" + JsonEscape(expected ?? "") +
                "\",\"requestedSha256\":\"" + JsonEscape(requested) +
                "\",\"phase\":\"" + JsonEscape(phase) +
                "\",\"transactionId\":\"" + JsonEscape(transactionId) +
                "\",\"detail\":\"" + JsonEscape(detail ?? "") +
                "\",\"recordedAt\":\"" + DateTime.UtcNow.ToString("o") + "\"}\n";
        }

        private static FileStream CreateJournal(string path)
        {
            SafeFileHandle handle = CreateFileW(
                path,
                GENERIC_READ | GENERIC_WRITE | DELETE,
                FILE_SHARE_READ,
                IntPtr.Zero,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH,
                IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(code, "Cannot exclusively create the CAS journal");
            }
            return new FileStream(handle, FileAccess.ReadWrite, 4096, false);
        }

        private static void AppendJournal(FileStream journal, string record)
        {
            byte[] bytes = new UTF8Encoding(false).GetBytes(record);
            journal.Seek(0, SeekOrigin.End);
            journal.Write(bytes, 0, bytes.Length);
            journal.Flush(true);
        }

        private static bool IsConflict(Exception error)
        {
            Win32Exception native = error as Win32Exception;
            if (native == null) return error is FileNotFoundException || error is DirectoryNotFoundException;
            return native.NativeErrorCode == ERROR_FILE_NOT_FOUND ||
                native.NativeErrorCode == ERROR_PATH_NOT_FOUND ||
                native.NativeErrorCode == ERROR_ACCESS_DENIED ||
                native.NativeErrorCode == ERROR_SHARING_VIOLATION ||
                native.NativeErrorCode == ERROR_FILE_EXISTS ||
                native.NativeErrorCode == ERROR_ALREADY_EXISTS;
        }

        private static void SignalAndWait(string signalPath, string continuePath)
        {
            if (!String.IsNullOrEmpty(signalPath))
            {
                using (FileStream signal = new FileStream(
                    signalPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                {
                    signal.Flush(true);
                }
            }
            if (!String.IsNullOrEmpty(continuePath))
            {
                DateTime deadline = DateTime.UtcNow.AddSeconds(30);
                while (!File.Exists(continuePath))
                {
                    if (DateTime.UtcNow >= deadline) throw new TimeoutException("CAS debug gate timed out");
                    System.Threading.Thread.Sleep(10);
                }
            }
        }

        private static DateTime LastWriteUtc(SafeFileHandle handle)
        {
            FILETIME time = Information(handle).LastWriteTime;
            long value = ((long)time.HighDateTime << 32) | time.LowDateTime;
            return DateTime.FromFileTimeUtc(value);
        }

        public static CasResult Execute(
            string root,
            string target,
            string candidate,
            string recovery,
            string journalPath,
            string transactionId,
            string targetRelativePath,
            string expectedSha256,
            string requestedSha256,
            string guardSignalPath,
            string guardContinuePath,
            string targetMovedSignalPath,
            string publishContinuePath,
            bool failMetadataAfterPublish)
        {
            CasResult result = new CasResult {
                Status = "failed", Phase = "not-started", Message = "CAS transaction did not start"
            };
            FileStream journal = null;
            SafeFileHandle targetHandle = null;
            SafeFileHandle candidateHandle = null;
            SafeFileHandle targetParentHandle = null;
            SafeFileHandle recoveryDirectoryHandle = null;
            SafeFileHandle journalDirectoryHandle = null;
            bool targetExists = false;
            try
            {
                string canonicalRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                string canonicalTarget = Path.GetFullPath(target);
                string canonicalCandidate = Path.GetFullPath(candidate);
                string canonicalRecovery = Path.GetFullPath(recovery);
                string canonicalJournal = Path.GetFullPath(journalPath);
                foreach (string path in new string[] { canonicalTarget, canonicalCandidate, canonicalRecovery, canonicalJournal })
                {
                    if (!path.StartsWith(canonicalRoot, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("A CAS transaction path escapes the approved root");
                }

                targetParentHandle = OpenGuardedDirectory(Path.GetDirectoryName(canonicalTarget), canonicalRoot);
                recoveryDirectoryHandle = OpenGuardedDirectory(Path.GetDirectoryName(canonicalRecovery), canonicalRoot);
                journalDirectoryHandle = OpenGuardedDirectory(Path.GetDirectoryName(canonicalJournal), canonicalRoot);
                candidateHandle = OpenGuardedFile(canonicalCandidate, canonicalRoot);
                string candidateHash = HashHandle(candidateHandle);
                if (!String.Equals(candidateHash, requestedSha256, StringComparison.OrdinalIgnoreCase))
                {
                    result.Status = "conflict";
                    result.Phase = "candidate-hash-conflict";
                    result.Message = "The guarded candidate changed before publication";
                    return result;
                }

                try
                {
                    targetHandle = OpenGuardedFile(canonicalTarget, canonicalRoot);
                    targetExists = true;
                }
                catch (Win32Exception error)
                {
                    if (error.NativeErrorCode != ERROR_FILE_NOT_FOUND && error.NativeErrorCode != ERROR_PATH_NOT_FOUND)
                        throw;
                }

                string currentHash = targetExists ? HashHandle(targetHandle) : "";
                if (expectedSha256 != null && !String.Equals(currentHash, expectedSha256, StringComparison.OrdinalIgnoreCase))
                {
                    result.Status = "conflict";
                    result.Phase = "expected-hash-conflict";
                    result.Message = "The target changed before the guarded CAS transaction";
                    return result;
                }

                EnsureSameVolume(
                    candidateHandle, targetParentHandle, recoveryDirectoryHandle,
                    journalDirectoryHandle, targetHandle);
                journal = CreateJournal(canonicalJournal);
                AppendJournal(journal, JournalRecord(
                    targetRelativePath, currentHash, requestedSha256,
                    "prepared", transactionId, "Guarded handles and hashes acquired"));
                result.Phase = "prepared";

                SignalAndWait(guardSignalPath, guardContinuePath);

                if (targetExists)
                {
                    RenameNoReplace(targetHandle, recoveryDirectoryHandle, canonicalRecovery);
                    result.TargetMoved = true;
                    result.Phase = "target-recovered";
                    AppendJournal(journal, JournalRecord(
                        targetRelativePath, currentHash, requestedSha256,
                        "target-recovered", transactionId, "Original target moved to recovery"));
                    SignalAndWait(targetMovedSignalPath, publishContinuePath);
                }

                try
                {
                    RenameNoReplace(candidateHandle, targetParentHandle, canonicalTarget);
                    result.CandidateMoved = true;
                }
                catch (Exception publishError)
                {
                    result.Status = IsConflict(publishError) ? "conflict" : "failed";
                    result.Phase = IsConflict(publishError) ? "publish-conflict" : "publish-failed";
                    result.Message = publishError.Message;
                    try
                    {
                        AppendJournal(journal, JournalRecord(
                            targetRelativePath, currentHash, requestedSha256,
                            result.Phase, transactionId,
                            "Recovery and candidate were deliberately retained; no rollback was attempted"));
                    }
                    catch (Exception metadataError)
                    {
                        result.MetadataWarning = metadataError.Message;
                    }
                    return result;
                }

                result.Status = "committed";
                result.Phase = targetExists ? "replacement-committed" : "new-file-committed";
                result.Message = "CAS transaction committed";
                try
                {
                    result.ModifiedAt = LastWriteUtc(candidateHandle).ToString("o");
                }
                catch (Exception metadataError)
                {
                    // Publication is the commit boundary. No metadata or
                    // timestamp failure after it may turn success into a retry.
                    result.MetadataWarning = metadataError.Message;
                }
                try
                {
                    if (failMetadataAfterPublish)
                    {
                        journal.Dispose();
                        journal = null;
                    }
                    AppendJournal(journal, JournalRecord(
                        targetRelativePath, currentHash, requestedSha256,
                        result.Phase, transactionId, "Candidate published with no-replace semantics"));
                }
                catch (Exception metadataError)
                {
                    // The file is already committed. Metadata failure must never turn a
                    // successful write into an ordinary failure that a caller might retry.
                    result.MetadataWarning = String.IsNullOrEmpty(result.MetadataWarning)
                        ? metadataError.Message
                        : result.MetadataWarning + "; " + metadataError.Message;
                }
                return result;
            }
            catch (Exception error)
            {
                if (result.CandidateMoved)
                {
                    result.Status = "committed";
                    result.Phase = targetExists ? "replacement-committed" : "new-file-committed";
                    result.Message = "CAS transaction committed";
                    result.MetadataWarning = error.Message;
                    return result;
                }
                result.Status = IsConflict(error) ? "conflict" : "failed";
                result.Phase = result.TargetMoved ? "partial-failure" : "guard-failed";
                result.Message = error.Message;
                if (journal != null)
                {
                    try
                    {
                        AppendJournal(journal, JournalRecord(
                            targetRelativePath, expectedSha256 ?? "", requestedSha256,
                            result.Phase, transactionId,
                            result.TargetMoved
                                ? "Recovery and candidate were retained; no rollback was attempted"
                                : "No target mutation occurred"));
                    }
                    catch (Exception metadataError)
                    {
                        result.MetadataWarning = metadataError.Message;
                    }
                }
                return result;
            }
            finally
            {
                if (journal != null) journal.Dispose();
                if (targetHandle != null) targetHandle.Dispose();
                if (candidateHandle != null) candidateHandle.Dispose();
                if (targetParentHandle != null) targetParentHandle.Dispose();
                if (recoveryDirectoryHandle != null) recoveryDirectoryHandle.Dispose();
                if (journalDirectoryHandle != null) journalDirectoryHandle.Dispose();
            }
        }
    }
}
`;

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
