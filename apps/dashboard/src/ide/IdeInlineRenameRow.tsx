import { Input } from "@fluentui/react-components";
import { DocumentRegular, FolderRegular } from "@fluentui/react-icons";
import { useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import type { IdeTreeSelection } from "./ide-create-entry.js";
import { renameWorkspaceEntryPath } from "./ide-create-entry.js";
import { messageFromError } from "./ide-tab-state.js";

interface IdeInlineRenameRowProps {
  entry: IdeTreeSelection;
  name: string;
  depth: number;
  onCancel: () => void;
  onRename: (entry: IdeTreeSelection, destinationPath: string) => Promise<void>;
}

export function IdeInlineRenameRow({
  entry,
  name: initialName,
  depth,
  onCancel,
  onRename,
}: IdeInlineRenameRowProps) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const style = { "--ide-tree-depth": depth } as CSSProperties;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (submitting || name.trim() === initialName) {
      onCancel();
      return;
    }
    let destinationPath: string;
    try {
      destinationPath = renameWorkspaceEntryPath(entry.path, name);
    } catch (caught) {
      setError(messageFromError(caught));
      return;
    }
    setSubmitting(true);
    try {
      await onRename(entry, destinationPath);
    } catch (caught) {
      setError(messageFromError(caught));
      setSubmitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };

  return (
    <form
      className="ide-inline-create"
      role="treeitem"
      aria-label={`重命名${entry.kind === "file" ? "文件" : "文件夹"}`}
      aria-busy={submitting}
      onSubmit={(event) => void submit(event)}
      onBlur={(event) => {
        if (submitting || event.currentTarget.contains(event.relatedTarget)) return;
        if (name.trim()) void submit();
        else onCancel();
      }}
    >
      <div className="ide-tree-row ide-tree-row-create" style={style}>
        <span className="ide-tree-chevron" aria-hidden="true" />
        <span className="ide-tree-kind" aria-hidden="true">
          {entry.kind === "file" ? <DocumentRegular /> : <FolderRegular />}
        </span>
        <Input
          className="ide-inline-create-input"
          size="small"
          autoFocus
          disabled={submitting}
          value={name}
          aria-invalid={Boolean(error)}
          aria-label="输入新名称"
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={handleKeyDown}
          onChange={(_, data) => {
            setName(data.value);
            setError(null);
          }}
        />
      </div>
      {error ? <div className="ide-inline-create-error" role="alert" style={style}>{error}</div> : null}
    </form>
  );
}
