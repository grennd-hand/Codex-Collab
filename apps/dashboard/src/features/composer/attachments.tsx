import {
  Button,
  Skeleton,
  SkeletonItem,
} from "@fluentui/react-components";
import {
  ArrowDownloadRegular,
  AttachRegular,
} from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import type {
  MessageAttachment,
  MessageAttachmentInput,
} from "@codex-collab/protocol";
import {
  MAX_MESSAGE_ATTACHMENT_COUNT,
  MAX_MESSAGE_ATTACHMENT_SIZE,
  MAX_MESSAGE_ATTACHMENT_TOTAL_SIZE,
} from "@codex-collab/protocol";
import { compressImageFile } from "../../shared/image-compression.js";

export interface PendingAttachment {
  id: string;
  file: File;
  originalSize?: number;
}

export interface PreparedAttachmentBatch {
  attachments: PendingAttachment[];
  warnings: string[];
}

export function formatFileSize(size: number): string {
  if (size < 1_000) return `${size} B`;
  if (size < 1_000_000) return `${Math.round(size / 1_000)} KB`;
  return `${(size / 1_000_000).toFixed(1)} MB`;
}

export function attachmentSizeLabel(attachment: PendingAttachment): string {
  return attachment.originalSize && attachment.originalSize > attachment.file.size
    ? `已压缩 ${formatFileSize(attachment.originalSize)} → ${formatFileSize(
        attachment.file.size,
      )}`
    : formatFileSize(attachment.file.size);
}

export async function prepareAttachmentBatch(
  files: readonly File[],
): Promise<PreparedAttachmentBatch> {
  const attachments: PendingAttachment[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    if (file.size === 0) {
      warnings.push(`空文件无法发送：${file.name}`);
      continue;
    }
    try {
      const prepared = await compressImageFile(file);
      attachments.push({
        id: crypto.randomUUID(),
        file: prepared.file,
        ...(prepared.compressed ? { originalSize: prepared.originalSize } : {}),
      });
    } catch {
      attachments.push({ id: crypto.randomUUID(), file });
      warnings.push(`图片压缩失败，已尝试保留原文件：${file.name}`);
    }
  }
  return { attachments, warnings };
}

export function appendPendingAttachments(
  current: readonly PendingAttachment[],
  incoming: readonly PendingAttachment[],
): { attachments: PendingAttachment[]; warning: string | null } {
  const next = [...current];
  let warning: string | null = null;
  for (const attachment of incoming) {
    const file = attachment.file;
    if (file.size > MAX_MESSAGE_ATTACHMENT_SIZE) {
      const sizeLimitMb = MAX_MESSAGE_ATTACHMENT_SIZE / 1_000_000;
      warning = attachment.originalSize
        ? `${file.name} 压缩后仍超过 ${sizeLimitMb} MB 单文件限制`
        : `${file.name} 超过 ${sizeLimitMb} MB 单文件限制`;
      continue;
    }
    if (
      next.some(
        (item) =>
          item.file.name === file.name &&
          item.file.size === file.size &&
          item.file.lastModified === file.lastModified,
      )
    ) {
      continue;
    }
    if (next.length >= MAX_MESSAGE_ATTACHMENT_COUNT) {
      warning = `一次最多发送 ${MAX_MESSAGE_ATTACHMENT_COUNT} 个附件`;
      break;
    }
    if (
      next.reduce((sum, item) => sum + item.file.size, 0) + file.size >
      MAX_MESSAGE_ATTACHMENT_TOTAL_SIZE
    ) {
      warning = `压缩后的附件总大小不能超过 ${
        MAX_MESSAGE_ATTACHMENT_TOTAL_SIZE / 1_000_000
      } MB`;
      break;
    }
    next.push(attachment);
  }
  return { attachments: next, warning };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取附件：${file.name}`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error(`无法读取附件：${file.name}`));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function serializeAttachment(
  attachment: PendingAttachment,
): Promise<MessageAttachmentInput> {
  return {
    name: attachment.file.name,
    mediaType: attachment.file.type || "application/octet-stream",
    size: attachment.file.size,
    dataBase64: await fileToBase64(attachment.file),
  };
}

async function fetchMessageAttachment(
  sessionId: string,
  messageId: string,
  attachmentId: string,
  token: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(
    `/v1/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(
      messageId,
    )}/attachments/${encodeURIComponent(attachmentId)}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(`附件读取失败（HTTP ${response.status}）`);
  }
  return response.blob();
}

export function PeerChatAttachment(props: {
  sessionId: string;
  messageId: string;
  attachment: MessageAttachment;
  token: string;
  onError(error: unknown): void;
}) {
  const { sessionId, messageId, attachment, token, onError } = props;
  const isImage = attachment.mediaType.startsWith("image/");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!isImage) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void fetchMessageAttachment(
      sessionId,
      messageId,
      attachment.id,
      token,
      controller.signal,
    )
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPreviewFailed(true);
        onError(error);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, isImage, messageId, onError, sessionId, token]);

  const download = async () => {
    setDownloading(true);
    try {
      const blob = await fetchMessageAttachment(
        sessionId,
        messageId,
        attachment.id,
        token,
      );
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = attachment.name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (error) {
      onError(error);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className={`peer-chat-attachment ${isImage ? "image" : "file"}`}>
      {isImage ? (
        <div className="peer-chat-image-preview">
          {previewUrl ? (
            <img src={previewUrl} alt={attachment.name} />
          ) : previewFailed ? (
            <span>图片预览不可用</span>
          ) : (
            <Skeleton aria-label="正在加载图片预览">
              <SkeletonItem />
            </Skeleton>
          )}
        </div>
      ) : null}
      <div className="peer-chat-attachment-row">
        <AttachRegular aria-hidden="true" />
        <div>
          <strong title={attachment.name}>{attachment.name}</strong>
          <small>{formatFileSize(attachment.size)}</small>
        </div>
        <Button
          type="button"
          appearance="subtle"
          size="small"
          icon={<ArrowDownloadRegular />}
          disabled={downloading}
          title={`下载 ${attachment.name}`}
          aria-label={`下载 ${attachment.name}`}
          onClick={() => void download()}
        />
      </div>
    </div>
  );
}
