export interface CopyAdapter {
  legacyCopy: (text: string) => boolean;
  writeClipboard?: (text: string) => Promise<void>;
}

export async function copyWithFallback(text: string, adapter: CopyAdapter): Promise<boolean> {
  if (!text) {
    return false;
  }

  if (adapter.writeClipboard) {
    try {
      await adapter.writeClipboard(text);
      return true;
    } catch {
      // Continue to the synchronous compatibility path when Clipboard API access is denied.
    }
  }

  try {
    return adapter.legacyCopy(text);
  } catch {
    return false;
  }
}

type SelectableTextControl = HTMLInputElement | HTMLTextAreaElement;

function legacyCopy(text: string, selectionTarget?: SelectableTextControl): boolean {
  const target = selectionTarget ?? document.createElement("textarea");
  const temporary = !selectionTarget;

  if (temporary) {
    const textarea = target as HTMLTextAreaElement;
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.position = "fixed";
    textarea.style.inset = "0 auto auto 0";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.opacity = "0.01";
    document.body.append(textarea);
  }

  try {
    target.focus({ preventScroll: true });
    target.select();
    target.setSelectionRange(0, target.value.length);
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } finally {
    if (temporary) {
      target.remove();
    }
  }
}

export function copyText(text: string, selectionTarget?: SelectableTextControl): Promise<boolean> {
  const clipboard =
    typeof navigator.clipboard?.writeText === "function"
      ? (value: string) => navigator.clipboard.writeText(value)
      : undefined;

  return copyWithFallback(text, {
    legacyCopy: (value) => legacyCopy(value, selectionTarget),
    ...(clipboard ? { writeClipboard: clipboard } : {}),
  });
}
