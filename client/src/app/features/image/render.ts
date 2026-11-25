/** Canvas renderer shared by the on-screen preview and every export. */
import { layout, NEUTRAL, viewSize, type Adjustments, type ImageDoc, type Layer } from './model';
import { drawBand } from '../../shared/band';
import { wrapText } from './text-layout';

export type Images = ReadonlyMap<string, CanvasImageSource & { width: number; height: number }>;

export function cssFilter(a: Adjustments, blurScale = 1): string {
  const parts: string[] = [];
  if (a.brightness !== 100) parts.push(`brightness(${a.brightness}%)`);
  if (a.contrast !== 100) parts.push(`contrast(${a.contrast}%)`);
  if (a.saturation !== 100) parts.push(`saturate(${a.saturation}%)`);
  if (a.hue) parts.push(`hue-rotate(${a.hue}deg)`);
  if (a.grayscale) parts.push(`grayscale(${a.grayscale}%)`);
  if (a.sepia) parts.push(`sepia(${a.sepia}%)`);
  if (a.invert) parts.push(`invert(${a.invert}%)`);
  if (a.blur) parts.push(`blur(${a.blur * blurScale}px)`);
  return parts.join(' ') || 'none';
}

const surface = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return { canvas, context: canvas.getContext('2d', { willReadFrequently: false })! };
};

/** Unsharp 3x3 kernel, blended by `amount` (0-1). */
export function sharpenPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
): void {
  const source = data.slice();
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const edge =
          4 * source[i + c]! -
          source[i - 4 + c]! -
          source[i + 4 + c]! -
          source[i - width * 4 + c]! -
          source[i + width * 4 + c]!;
        data[i + c] = source[i + c]! + edge * amount;
      }
    }
  }
}

/** Builds the photo area: rotate, flip, crop and adjustments. */
export function renderPhoto(doc: ImageDoc, images: Images): HTMLCanvasElement {
  const { photo } = layout(doc);
  const { canvas, context } = surface(photo.width, photo.height);
  const a = { ...NEUTRAL, ...doc.adjustments };
  const source = doc.base.mediaId ? images.get(doc.base.mediaId) : null;

  const raw = surface(photo.width, photo.height);
  if (!doc.base.mediaId) {
    if (doc.background2) {
      const gradient = raw.context.createLinearGradient(0, 0, photo.width, photo.height);
      gradient.addColorStop(0, doc.background);
      gradient.addColorStop(1, doc.background2);
      raw.context.fillStyle = gradient;
    } else {
      raw.context.fillStyle = doc.background;
    }
    raw.context.fillRect(0, 0, photo.width, photo.height);
  } else if (source) {
    const view = viewSize(doc);
    const g = raw.context;
    g.translate(-(doc.crop?.x ?? 0) * view.width, -(doc.crop?.y ?? 0) * view.height);
    g.translate(view.width / 2, view.height / 2);
    g.scale(doc.flipH ? -1 : 1, doc.flipV ? -1 : 1);
    g.rotate((doc.rotation * Math.PI) / 180);
    g.drawImage(source, -doc.base.width / 2, -doc.base.height / 2, doc.base.width, doc.base.height);
  }

  context.filter = cssFilter(a);
  if (a.pixelate > 0) {
    const block = 1 + a.pixelate;
    const small = surface(photo.width / block, photo.height / block);
    small.context.drawImage(raw.canvas, 0, 0, small.canvas.width, small.canvas.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(small.canvas, 0, 0, photo.width, photo.height);
    context.imageSmoothingEnabled = true;
  } else {
    context.drawImage(raw.canvas, 0, 0);
  }
  context.filter = 'none';

  if (a.sharpen > 0) {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    sharpenPixels(pixels.data, canvas.width, canvas.height, a.sharpen / 100);
    context.putImageData(pixels, 0, 0);
  }
  if (a.warmth) {
    context.globalCompositeOperation = 'soft-light';
    context.globalAlpha = Math.abs(a.warmth) / 100;
    context.fillStyle = a.warmth > 0 ? '#ff8a00' : '#0076ff';
    context.fillRect(0, 0, photo.width, photo.height);
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
  }
  if (a.vignette) {
    const radius = Math.hypot(photo.width, photo.height) / 2;
    const gradient = context.createRadialGradient(
      photo.width / 2,
      photo.height / 2,
      radius * 0.35,
      photo.width / 2,
      photo.height / 2,
      radius,
    );
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, `rgba(0,0,0,${a.vignette / 100})`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, photo.width, photo.height);
  }
  return canvas;
}

function shapePath(g: CanvasRenderingContext2D, layer: Layer): void {
  const w = layer.w;
  const h = layer.h;
  const polygon = (points: [number, number][]) => {
    points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
  };
  g.beginPath();
  switch (layer.shape) {
    case 'ellipse':
      g.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case 'triangle':
      polygon([
        [0, -h / 2],
        [w / 2, h / 2],
        [-w / 2, h / 2],
      ]);
      break;
    case 'hexagon':
      polygon([
        [-w / 4, -h / 2],
        [w / 4, -h / 2],
        [w / 2, 0],
        [w / 4, h / 2],
        [-w / 4, h / 2],
        [-w / 2, 0],
      ]);
      break;
    case 'star':
      polygon(
        Array.from({ length: 10 }, (_, i): [number, number] => {
          const angle = (Math.PI / 5) * i - Math.PI / 2;
          const r = i % 2 ? 0.22 : 0.5;
          return [Math.cos(angle) * w * r, Math.sin(angle) * h * r];
        }),
      );
      break;
    case 'heart':
      g.moveTo(0, h / 2);
      g.bezierCurveTo(-w * 0.75, h * 0.02, -w * 0.45, -h * 0.72, 0, -h * 0.22);
      g.bezierCurveTo(w * 0.45, -h * 0.72, w * 0.75, h * 0.02, 0, h / 2);
      break;
    case 'line':
    case 'arrow': {
      g.moveTo(-w / 2, 0);
      g.lineTo(w / 2, 0);
      if (layer.shape === 'arrow') {
        const head = Math.min(w * 0.4, Math.max(18, layer.strokeWidth * 4));
        g.moveTo(w / 2 - head, -head * 0.6);
        g.lineTo(w / 2, 0);
        g.lineTo(w / 2 - head, head * 0.6);
      }
      break;
    }
    default:
      g.roundRect(-w / 2, -h / 2, w, h, Math.min(layer.radius, w / 2, h / 2));
  }
}

const fontOf = (layer: Pick<Layer, 'italic' | 'bold' | 'fontSize' | 'fontFamily'>) =>
  `${layer.italic ? 'italic ' : ''}${layer.bold ? 'bold ' : ''}${layer.fontSize}px ${layer.fontFamily}`;

let measurer: CanvasRenderingContext2D | null = null;

/** Height of a wrapped text layer, so its selection box matches what is drawn. */
export function textHeight(layer: Layer): number {
  measurer ??= document.createElement('canvas').getContext('2d')!;
  measurer.font = fontOf(layer);
  const lines = wrapText(layer.text || ' ', layer.w, (t) => measurer!.measureText(t).width);
  return Math.ceil(lines.length * layer.fontSize * 1.2);
}

function drawText(g: CanvasRenderingContext2D, layer: Layer, width: number): void {
  g.font = fontOf(layer);
  g.textBaseline = 'middle';
  g.textAlign = layer.align;
  const x = layer.align === 'left' ? -width / 2 : layer.align === 'right' ? width / 2 : 0;
  const lines = wrapText(layer.text, width, (t) => g.measureText(t).width);
  const step = layer.fontSize * 1.2;
  lines.forEach((line, i) => {
    const y = (i - (lines.length - 1) / 2) * step;
    if (layer.strokeWidth > 0 && layer.type === 'text') {
      g.lineJoin = 'round';
      g.lineWidth = layer.strokeWidth * 2;
      g.strokeStyle = layer.stroke;
      g.strokeText(line, x, y);
      // The shadow belongs to the outline; drawing it twice would darken it.
      g.shadowColor = 'transparent';
    }
    g.fillStyle = layer.color;
    g.fillText(line, x, y);
  });
}

function drawStrokes(layer: Layer, width: number, height: number): HTMLCanvasElement {
  const { canvas, context } = surface(width, height);
  context.lineCap = context.lineJoin = 'round';
  for (const stroke of layer.strokes) {
    context.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.size;
    context.beginPath();
    const p = stroke.points;
    context.moveTo(p[0]!, p[1]!);
    if (p.length === 2) context.lineTo(p[0]! + 0.01, p[1]!);
    for (let i = 2; i < p.length; i += 2) context.lineTo(p[i]!, p[i + 1]!);
    context.stroke();
  }
  return canvas;
}

export function drawLayer(
  g: CanvasRenderingContext2D,
  layer: Layer,
  images: Images,
  photo: { width: number; height: number },
  shadowScale: number,
): void {
  if (layer.hidden) return;
  g.save();
  g.globalAlpha = layer.opacity;
  g.globalCompositeOperation = layer.blend;
  if (layer.shadow.enabled) {
    g.shadowColor = layer.shadow.color;
    // Canvas shadow values ignore the transform, so scale them by hand.
    g.shadowBlur = layer.shadow.blur * shadowScale;
    g.shadowOffsetX = layer.shadow.dx * shadowScale;
    g.shadowOffsetY = layer.shadow.dy * shadowScale;
  }
  if (layer.type === 'draw') {
    g.drawImage(drawStrokes(layer, photo.width, photo.height), layer.x, layer.y);
    g.restore();
    return;
  }
  g.translate(layer.x, layer.y);
  g.rotate((layer.rotation * Math.PI) / 180);
  const { w, h } = layer;
  switch (layer.type) {
    case 'text':
      drawText(g, layer, w);
      break;
    case 'sticker':
      g.font = `${layer.fontSize}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(layer.text, 0, layer.fontSize * 0.04);
      break;
    case 'bubble':
      g.beginPath();
      g.roundRect(-w / 2, -h / 2, w, h * 0.82, Math.min(w, h) * 0.2);
      g.moveTo(-w * 0.18, h * 0.31);
      g.lineTo(-w * 0.28, h / 2);
      g.lineTo(w * 0.02, h * 0.31);
      g.fillStyle = layer.fill;
      g.fill();
      g.shadowColor = 'transparent';
      g.translate(0, -h * 0.09);
      drawText(g, layer, w * 0.86);
      break;
    case 'shape': {
      shapePath(g, layer);
      const open = layer.shape === 'line' || layer.shape === 'arrow';
      if (!open && layer.fill) {
        g.fillStyle = layer.fill;
        g.fill();
        g.shadowColor = 'transparent';
      }
      const width = open ? Math.max(1, layer.strokeWidth) : layer.strokeWidth;
      if (width > 0) {
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.lineWidth = width;
        g.strokeStyle = layer.stroke;
        g.stroke();
      }
      break;
    }
    case 'image': {
      const image = layer.mediaId ? images.get(layer.mediaId) : null;
      if (image) {
        g.beginPath();
        g.roundRect(-w / 2, -h / 2, w, h, Math.min(layer.radius, w / 2, h / 2));
        if (layer.radius > 0) g.clip();
        g.drawImage(image, -w / 2, -h / 2, w, h);
      }
      break;
    }
  }
  g.restore();
}

/** Renders the finished picture onto `target`, at `scale` times its natural size. */
export function renderDoc(
  target: HTMLCanvasElement,
  doc: ImageDoc,
  images: Images,
  photo: HTMLCanvasElement,
  scale = 1,
): void {
  const box = layout(doc);
  const width = Math.max(1, Math.round(box.width * scale));
  const height = Math.max(1, Math.round(box.height * scale));
  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;
  const g = target.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, width, height);
  g.scale(width / box.width, height / box.height);
  if (doc.frame.width > 0) {
    g.fillStyle = doc.frame.color;
    g.fillRect(0, 0, box.width, box.height);
  }
  for (const area of box.bands) {
    drawBand(g, doc.sections[area.key], area.x, area.y, area.w, area.h, area.turns);
  }
  const style = doc.photoStyle;
  g.save();
  g.globalAlpha = style.opacity;
  g.beginPath();
  g.roundRect(box.originX, box.originY, box.photo.width, box.photo.height, doc.frame.radius);
  g.clip();
  g.drawImage(photo, box.originX, box.originY);
  if (style.borderWidth > 0) {
    // Stroked inside the clip, so twice the width shows as the chosen width.
    g.lineWidth = style.borderWidth * 2;
    g.strokeStyle = style.borderColor;
    g.stroke();
  }
  g.restore();
  g.save();
  g.translate(box.originX, box.originY);
  for (const layer of doc.layers) drawLayer(g, layer, images, box.photo, scale);
  g.restore();
}
