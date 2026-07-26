const compressibleImageTypes = new Set([
  "image/avif",
  "image/bmp",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const preservedImageTypes = new Set([
  "image/gif",
  "image/svg+xml",
  "image/apng",
]);

export const imageCompressionMaxEdge = 1_920;
export const imageCompressionTargetSize = 1_000_000;

const qualitySteps = [0.82, 0.7, 0.58, 0.46];
const scaleSteps = [1, 0.84, 0.7];

export interface PreparedImageFile {
  file: File;
  originalSize: number;
  compressed: boolean;
}

export function shouldCompressImage(
  file: Pick<File, "size" | "type"> & Partial<Pick<File, "name">>,
): boolean {
  if (!file.type.startsWith("image/") || preservedImageTypes.has(file.type)) {
    return (
      file.size > 0 &&
      !file.type &&
      typeof file.name === "string" &&
      /\.(?:avif|bmp|heic|heif|jpe?g|png|webp)$/i.test(file.name)
    );
  }
  return compressibleImageTypes.has(file.type) && file.size > 0;
}

export function scaledImageDimensions(
  width: number,
  height: number,
  maxEdge = imageCompressionMaxEdge,
): { width: number; height: number } {
  const longestEdge = Math.max(width, height);
  const ratio = longestEdge > maxEdge ? maxEdge / longestEdge : 1;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

export function compressedImageName(name: string, mediaType: string): string {
  const extension =
    mediaType === "image/webp"
      ? ".webp"
      : mediaType === "image/jpeg"
        ? ".jpg"
        : mediaType === "image/png"
          ? ".png"
          : "";
  if (!extension) return name;
  const base = name.replace(/\.[^./\\]+$/, "") || "image";
  return `${base}${extension}`;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function loadImage(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose(): void;
}> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close(),
    };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`无法解析图片：${file.name}`));
      element.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

export async function compressImageFile(file: File): Promise<PreparedImageFile> {
  if (!shouldCompressImage(file)) {
    return { file, originalSize: file.size, compressed: false };
  }

  const image = await loadImage(file);
  try {
    if (image.width <= 0 || image.height <= 0) {
      return { file, originalSize: file.size, compressed: false };
    }

    const base = scaledImageDimensions(image.width, image.height);
    let smallest: Blob | null = null;

    for (const scale of scaleSteps) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(base.width * scale));
      canvas.height = Math.max(1, Math.round(base.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("当前浏览器无法压缩图片");
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image.source, 0, 0, canvas.width, canvas.height);

      for (const quality of qualitySteps) {
        const candidate = await canvasToBlob(canvas, "image/webp", quality);
        if (!candidate) continue;
        if (!smallest || candidate.size < smallest.size) smallest = candidate;
        if (candidate.size <= imageCompressionTargetSize) break;
      }

      if (smallest && smallest.size <= imageCompressionTargetSize) break;
    }

    if (!smallest || smallest.size >= file.size) {
      return { file, originalSize: file.size, compressed: false };
    }

    const compressed = new File(
      [smallest],
      compressedImageName(file.name, smallest.type),
      {
        type: smallest.type || "image/webp",
        lastModified: file.lastModified,
      },
    );
    return { file: compressed, originalSize: file.size, compressed: true };
  } finally {
    image.dispose();
  }
}
