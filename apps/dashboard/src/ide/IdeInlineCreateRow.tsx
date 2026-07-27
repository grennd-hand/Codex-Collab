import { Input } from "@fluentui/react-components";
import {
  DocumentAddRegular,
  FolderAddRegular,
} from "@fluentui/react-icons";
import {
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  createWorkspaceEntryPath,
  type IdeCreateEntryKind,
} from "./ide-create-entry.js";
import { messageFromError } from "./ide-tab-state.js";

interface IdeInlineCreateRowProps {
  kind: IdeCreateEntryKind;
  parentPath: string;
  depth: number;
  onCancel: () => void;
  onCreate: (path: string) => Promise<void>;
}

export function IdeInlineCreateRow({
  kind,
  parentPath,
  depth,
  onCancel,
  onCreate,
}: IdeInlineCreateRowProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const style = { "--ide-tree-depth": depth } as CSSProperties;
  const label = kind === "directory" ? "文件夹" : "文件";

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (submitting) return;
    let path: string;
    try {
      path = createWorkspaceEntryPath(parentPath, name);
    } catch (caught) {
      setError(messageFromError(caught));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(path);
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
      aria-label={`新建${label}`}
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
          {kind === "directory" ? <FolderAddRegular /> : <DocumentAddRegular />}
        </span>
        <Input
          className="ide-inline-create-input"
          size="small"
          autoFocus
          disabled={submitting}
          value={name}
          aria-label={`输入新${label}名称`}
          aria-invalid={Boolean(error)}
          onKeyDown={handleKeyDown}
          onChange={(_, data) => {
            setName(data.value);
            setError(null);
          }}
        />
      </div>
      {error ? (
        <div className="ide-inline-create-error" role="alert" style={style}>
          {error}
        </div>
      ) : null}
    </form>
  );
}
