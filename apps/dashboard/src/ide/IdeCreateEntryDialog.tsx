import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
} from "@fluentui/react-components";
import { useEffect, useId, useState, type FormEvent } from "react";
import { messageFromError } from "./ide-tab-state.js";

interface IdeCreateEntryDialogProps {
  kind: "file" | "directory" | null;
  onClose: () => void;
  onCreateFile: (path: string) => Promise<void>;
  onCreateDirectory: (path: string) => Promise<void>;
}

export function IdeCreateEntryDialog({
  kind,
  onClose,
  onCreateFile,
  onCreateDirectory,
}: IdeCreateEntryDialogProps) {
  const descriptionId = useId();
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!kind) return;
    setPath("");
    setError(null);
    setSubmitting(false);
  }, [kind]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const requestedPath = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (!requestedPath) {
      setError("请输入相对项目根目录的路径。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (kind === "file") await onCreateFile(requestedPath);
      else await onCreateDirectory(requestedPath);
      onClose();
    } catch (caught) {
      setError(messageFromError(caught));
      setSubmitting(false);
    }
  };

  const title = kind === "file" ? "新建文件" : "新建文件夹";
  return (
    <Dialog open={kind !== null} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface className="ide-create-entry-dialog">
        <form onSubmit={(event) => void submit(event)}>
          <DialogBody>
            <DialogTitle>{title}</DialogTitle>
            <DialogContent>
              <p id={descriptionId}>
                使用项目根目录内的相对路径，例如 {kind === "file" ? "src/new-file.ts" : "src/components"}。
              </p>
              <Field
                label={kind === "file" ? "文件路径" : "文件夹路径"}
                validationMessage={error}
                validationState={error ? "error" : "none"}
              >
                <Input
                  autoFocus
                  value={path}
                  disabled={submitting}
                  aria-describedby={descriptionId}
                  onChange={(_, data) => setPath(data.value)}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={submitting} onClick={onClose}>
                取消
              </Button>
              <Button appearance="primary" type="submit" disabled={submitting}>
                {submitting ? "正在创建" : "创建"}
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
