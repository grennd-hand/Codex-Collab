export const WINDOWS_CAS_TRANSACTION_SOURCE = String.raw`
namespace CodexCollabAtomicWrite
{
    public static partial class WindowsCas
    {
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
