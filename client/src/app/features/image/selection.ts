/** Lasso and magic-wand selections, in the pixels of the composed picture. */
import { clamp } from '../../core/util';
import type { Point, Rect } from '../pdf/model';

export interface Selection {
  bounds: Rect;
  /** Freehand outline, if drawn by hand. */
  points: Point[] | null;
  /** Magic-wand result: one byte per picture pixel. */
  mask: Uint8Array | null;
  width: number;
  height: number;
}

/** Selects the connected area whose colour is close to the clicked pixel. `tolerance` is 0-100. */
export function magicWand(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  tolerance: number,
): Selection | null {
  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  const seed = (sy * width + sx) * 4;
  const [r, g, b, a] = [data[seed]!, data[seed + 1]!, data[seed + 2]!, data[seed + 3]!];
  const limit = ((clamp(tolerance, 0, 100) / 100) * 300) ** 2;
  const mask = new Uint8Array(width * height);
  const seen = new Uint8Array(width * height);
  // A typed array as the stack: each pixel is pushed at most once.
  const stack = new Int32Array(width * height);
  let top = 0;
  let left = sx,
    right = sx,
    up = sy,
    down = sy;
  const visit = (p: number) => {
    if (!seen[p]) {
      seen[p] = 1;
      stack[top++] = p;
    }
  };
  visit(sy * width + sx);
  while (top > 0) {
    const p = stack[--top]!;
    const i = p * 4;
    const distance =
      (data[i]! - r) ** 2 +
      (data[i + 1]! - g) ** 2 +
      (data[i + 2]! - b) ** 2 +
      (data[i + 3]! - a) ** 2;
    if (distance > limit) continue;
    mask[p] = 1;
    const x = p % width;
    const y = (p - x) / width;
    left = Math.min(left, x);
    right = Math.max(right, x);
    up = Math.min(up, y);
    down = Math.max(down, y);
    if (x > 0) visit(p - 1);
    if (x < width - 1) visit(p + 1);
    if (y > 0) visit(p - width);
    if (y < height - 1) visit(p + width);
  }
  return {
    bounds: { x: left, y: up, w: right - left + 1, h: down - up + 1 },
    points: null,
    mask,
    width,
    height,
  };
}

export function freehand(points: Point[], width: number, height: number): Selection | null {
  if (points.length < 3) return null;
  const xs = points.map((p) => clamp(p.x, 0, width));
  const ys = points.map((p) => clamp(p.y, 0, height));
  const x = Math.floor(Math.min(...xs));
  const y = Math.floor(Math.min(...ys));
  const bounds = { x, y, w: Math.ceil(Math.max(...xs)) - x, h: Math.ceil(Math.max(...ys)) - y };
  return bounds.w < 4 || bounds.h < 4 ? null : { bounds, points, mask: null, width, height };
}

/** Moves one corner of the selection box, keeping the opposite corner still. */
export function resizeBounds(
  bounds: Rect,
  corner: 'nw' | 'ne' | 'sw' | 'se',
  to: Point,
  width: number,
  height: number,
): Rect {
  let left = bounds.x,
    top = bounds.y,
    right = bounds.x + bounds.w,
    bottom = bounds.y + bounds.h;
  if (corner.endsWith('w')) left = clamp(to.x, 0, right - 4);
  else right = clamp(to.x, left + 4, width);
  if (corner.startsWith('n')) top = clamp(to.y, 0, bottom - 4);
  else bottom = clamp(to.y, top + 4, height);
  return {
    x: Math.round(left),
    y: Math.round(top),
    w: Math.round(right - left),
    h: Math.round(bottom - top),
  };
}

/** Copies the selected pixels onto a new transparent canvas the size of the selection box. */
export function cutOut(source: HTMLCanvasElement, selection: Selection): HTMLCanvasElement {
  const { bounds, points, mask, width } = selection;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, bounds.w);
  canvas.height = Math.max(1, bounds.h);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  if (points) {
    g.beginPath();
    points.forEach((p, i) =>
      i ? g.lineTo(p.x - bounds.x, p.y - bounds.y) : g.moveTo(p.x - bounds.x, p.y - bounds.y),
    );
    g.closePath();
    g.clip();
  }
  g.drawImage(source, -bounds.x, -bounds.y);
  if (mask) {
    const pixels = g.getImageData(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (!mask[(bounds.y + y) * width + bounds.x + x])
          pixels.data[(y * canvas.width + x) * 4 + 3] = 0;
      }
    }
    g.putImageData(pixels, 0, 0);
  }
  return canvas;
}

/** Tints the selected area and outlines its box. */
export function drawSelection(
  canvas: HTMLCanvasElement,
  selection: Selection | null,
  trail: Point[],
): void {
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, canvas.width, canvas.height);
  const line = Math.max(1.5, canvas.width / 500);
  const path = (points: Point[]) => {
    g.beginPath();
    points.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  };
  g.lineWidth = line;
  g.strokeStyle = '#4f46e5';
  if (trail.length > 1) {
    path(trail);
    g.stroke();
  }
  if (!selection) return;
  if (selection.mask) {
    const tint = g.createImageData(selection.width, selection.height);
    for (let p = 0; p < selection.mask.length; p++) {
      if (selection.mask[p]) tint.data.set([79, 70, 229, 120], p * 4);
    }
    g.putImageData(tint, 0, 0);
  }
  if (selection.points) {
    path(selection.points);
    g.closePath();
    g.fillStyle = 'rgb(79 70 229 / 30%)';
    g.fill();
    g.stroke();
  }
  g.setLineDash([line * 4, line * 3]);
  const { x, y, w, h } = selection.bounds;
  g.strokeRect(x, y, w, h);
  g.setLineDash([]);
}
