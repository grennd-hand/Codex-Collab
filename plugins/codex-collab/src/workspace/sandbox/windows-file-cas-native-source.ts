export const WINDOWS_CAS_NATIVE_SOURCE = String.raw`
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

    public static partial class WindowsCas
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
                    byte[] processId = Encoding.ASCII.GetBytes(
                        System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
                    signal.Write(processId, 0, processId.Length);
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

    }
}
`;
