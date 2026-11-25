import { mediaUrl } from '../../core/media';
import { canvasBlob, loadImage } from '../../core/util';
import { wrapText } from '../image/text-layout';
import type { ExportHost } from './export';
import { openPdf } from './pdfjs';

const png = async (canvas: HTMLCanvasElement) =>
  new Uint8Array(await (await canvasBlob(canvas)).arrayBuffer());

/** Fetches library files once per editor session. */
export function createSourceCache(): (id: string) => Promise<Uint8Array> {
  const cache = new Map<string, Promise<Uint8Array>>();
  return (id) => {
    let bytes = cache.get(id);
    if (!bytes) {
      bytes = fetch(mediaUrl(id)).then(async (response) => {
        if (!response.ok) throw new Error('A source PDF is missing from the library');
        return new Uint8Array(await response.arrayBuffer());
      });
      bytes.catch(() => cache.delete(id));
      cache.set(id, bytes);
    }
    return bytes;
  };
}

export function browserHost(sourceBytes: ExportHost['sourceBytes']): ExportHost {
  return {
    sourceBytes,
    async imagePng(src) {
      const image = await loadImage(src);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
      return png(canvas);
    },
    async rasterize(bytes, index, boxes) {
      const document_ = await openPdf(bytes);
      try {
        const page = await document_.getPage(index + 1);
        const base = page.getViewport({ scale: 1, rotation: 0 });
        const scale = Math.min(3, 3000 / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale, rotation: 0 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvas, viewport }).promise;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#000';
        for (const box of boxes) {
          context.fillRect(
            box.x * canvas.width,
            box.y * canvas.height,
            box.w * canvas.width,
            box.h * canvas.height,
          );
        }
        return { png: await png(canvas) };
      } finally {
        await document_.loadingTask.destroy();
      }
    },
    async textPng(text, size, fill, bold, width, height) {
      const scale = 4;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const context = canvas.getContext('2d')!;
      context.scale(scale, scale);
      context.font = `${bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
      context.fillStyle = fill;
      context.textBaseline = 'alphabetic';
      wrapText(text, width, (t) => context.measureText(t).width).forEach((line, i) =>
        context.fillText(line, 2, size * (1.2 * i + 0.95)),
      );
      return png(canvas);
    },
  };
}
