export const WINDOWS_ENTRY_RENAME_SOURCE = String.raw`
namespace CodexCollabAtomicWrite
{
    public sealed class RenameResult
    {
        public string Status { get; set; }
        public string Message { get; set; }
    }

    public static partial class WindowsCas
    {
        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;

        private static SafeFileHandle OpenGuardedRenameDirectory(
            string path,
            string canonicalRoot)
        {
            SafeFileHandle handle = CreateFileW(
                path,
                GENERIC_READ | DELETE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int code = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(code, "Cannot acquire the guarded directory handle");
            }
            BY_HANDLE_FILE_INFORMATION information = Information(handle);
            if ((information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
                (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0)
            {
                handle.Dispose();
                throw new IOException("The guarded source is not a regular directory");
            }
            ValidateInsideRoot(handle, canonicalRoot);
            return handle;
        }

        public static RenameResult RenameEntry(
            string root,
            string source,
            string destinationParent,
            string destination,
            string expectedSha256,
            bool isDirectory)
        {
            try
            {
                using (SafeFileHandle parent = OpenGuardedDirectory(destinationParent, root))
                using (SafeFileHandle entry = isDirectory
                    ? OpenGuardedRenameDirectory(source, root)
                    : OpenGuardedFile(source, root))
                {
                    if (!isDirectory && !String.Equals(
                        HashHandle(entry), expectedSha256, StringComparison.OrdinalIgnoreCase))
                    {
                        return new RenameResult {
                            Status = "conflict",
                            Message = "The source file hash changed"
                        };
                    }
                    RenameNoReplace(entry, parent, destination);
                }
                return new RenameResult { Status = "committed", Message = "Renamed" };
            }
            catch (Exception error)
            {
                return new RenameResult {
                    Status = IsConflict(error) ? "conflict" : "failed",
                    Message = error.Message
                };
            }
        }
    }
}
`;
