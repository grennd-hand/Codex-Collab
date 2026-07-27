export type IdeThemeMode = "light" | "dark";

export type IdeFileOperationStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export interface IdeWorkspaceFile {
  path: string;
  size: number;
  modifiedAt: string;
  sha256: string;
}

export interface IdeFileDocument extends IdeWorkspaceFile {
  content: string;
}

export interface IdeSaveRequest {
  path: string;
  content: string;
  expectedSha256: string;
}

export interface IdeNavigationTarget {
  path: string;
  line?: number;
  column?: number;
}

export interface IdeOpenFileRequest extends IdeNavigationTarget {
  requestId: number;
}

export type IdeSaveResult =
  | {
      status: "saved";
      file: IdeFileDocument;
    }
  | {
      status: "conflict";
      file: IdeFileDocument;
      message?: string;
    };

export interface IdeWorkspaceProps {
  files: readonly IdeWorkspaceFile[];
  fileChanges?: readonly CodexFileChange[];
  rootLabel: string | null;
  hostDeviceLabel: string | null;
  selectedThreadLabel: string | null;
  syncedAt: string | null;
  themeMode: IdeThemeMode;
  readOnly: boolean;
  readOnlyReason?: string;
  loading?: boolean;
  onReadFile: (path: string) => Promise<IdeFileDocument>;
  onSaveFile: (request: IdeSaveRequest) => Promise<IdeSaveResult>;
  onRefresh: () => void | Promise<void>;
  openFileRequest?: IdeOpenFileRequest | null;
  storageScope?: string;
  embedded?: boolean;
  editorExpanded?: boolean;
  onEditorExpandedChange?: (expanded: boolean) => void;
  onClose?: () => void;
}
import type { CodexFileChange } from "@codex-collab/protocol";
