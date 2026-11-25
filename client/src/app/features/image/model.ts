/**
 * Image edit model. Layer positions are centre points in output pixels, measured from the top-left of the
 * photo area (after rotate, flip and crop). The source picture is never modified.
 */
import { clamp, uid } from '../../core/util';
import { rectToDisplay, toDisplay } from '../pdf/geometry';
import type { Rect, Rotation } from '../pdf/model';
import type { Band } from '../../shared/band';
import { emptySections, type SectionKey } from './sections';

export interface Adjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  grayscale: number;
  sepia: number;
  invert: number;
  blur: number;
  pixelate: number;
  sharpen: number;
  vignette: number;
  warmth: number;
}

export const NEUTRAL: Adjustments = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  hue: 0,
  grayscale: 0,
  sepia: 0,
  invert: 0,
  blur: 0,
  pixelate: 0,
  sharpen: 0,
  vignette: 0,
  warmth: 0,
};

export const PRESETS: { name: string; values: Partial<Adjustments> }[] = [
  { name: 'Original', values: {} },
  { name: 'Vivid', values: { saturation: 150, contrast: 115 } },
  { name: 'B & W', values: { grayscale: 100, contrast: 115 } },
  { name: 'Vintage', values: { sepia: 55, contrast: 90, brightness: 108, vignette: 35 } },
  { name: 'Warm', values: { warmth: 45, saturation: 110 } },
  { name: 'Cool', values: { warmth: -45 } },
  { name: 'Dramatic', values: { contrast: 145, saturation: 85, vignette: 55 } },
  { name: 'Fade', values: { contrast: 80, brightness: 112, saturation: 75 } },
];

export type ShapeKind =
  'rect' | 'ellipse' | 'line' | 'arrow' | 'triangle' | 'star' | 'hexagon' | 'heart';
export type LayerType = 'text' | 'bubble' | 'sticker' | 'shape' | 'image' | 'draw';

export interface Stroke {
  /** Flat list of x, y pairs in photo pixels. */
  points: number[];
  color: string;
  size: number;
  erase: boolean;
}

export interface Layer {
  id: string;
  type: LayerType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  opacity: number;
  blend: GlobalCompositeOperation;
  hidden: boolean;
  locked: boolean;
  shadow: { enabled: boolean; color: string; blur: number; dx: number; dy: number };
  text: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  color: string;
  stroke: string;
  strokeWidth: number;
  fill: string;
  radius: number;
  shape: ShapeKind;
  mediaId: string | null;
  strokes: Stroke[];
}

export interface ImageDoc {
  base: { mediaId: string | null; width: number; height: number };
  background: string;
  /** Second gradient colour for a blank canvas, or empty for a flat fill. */
  background2: string;
  rotation: Rotation;
  flipH: boolean;
  flipV: boolean;
  /** Fractions of the rotated and flipped picture. */
  crop: Rect | null;
  adjustments: Adjustments;
  layers: Layer[];
  sections: Record<SectionKey, Band>;
  frame: { width: number; color: string; radius: number };
  /** Styling of the photo itself, inside the sections. */
  photoStyle: { borderWidth: number; borderColor: string; opacity: number };
}

export const FONTS = [
  { label: 'Sans', value: 'system-ui, Arial, sans-serif' },
  { label: 'Impact', value: 'Impact, "Arial Narrow", sans-serif' },
  { label: 'Serif', value: 'Georgia, serif' },
  { label: 'Mono', value: '"Courier New", monospace' },
  { label: 'Rounded', value: '"Trebuchet MS", sans-serif' },
  { label: 'Script', value: '"Segoe Script", "Brush Script MT", cursive' },
  { label: 'Comic', value: '"Comic Sans MS", cursive' },
];

export const CANVAS_PRESETS = [
  { label: 'Square post (1080 × 1080)', width: 1080, height: 1080 },
  { label: 'Story (1080 × 1920)', width: 1080, height: 1920 },
  { label: 'Video thumbnail (1280 × 720)', width: 1280, height: 720 },
  { label: 'Cover banner (1640 × 624)', width: 1640, height: 624 },
  { label: 'A4 poster (1240 × 1754)', width: 1240, height: 1754 },
];

export const BLEND_MODES: GlobalCompositeOperation[] = [
  'source-over',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'difference',
  'hard-light',
  'soft-light',
];

export const emptyImageDoc = (
  width = 1080,
  height = 1080,
  mediaId: string | null = null,
): ImageDoc => ({
  base: { mediaId, width, height },
  background: '#ffffff',
  background2: '',
  rotation: 0,
  flipH: false,
  flipV: false,
  crop: null,
  adjustments: { ...NEUTRAL },
  layers: [],
  sections: emptySections(),
  frame: { width: 0, color: '#ffffff', radius: 0 },
  photoStyle: { borderWidth: 0, borderColor: '#111827', opacity: 1 },
});

export const createLayer = (type: LayerType, patch: Partial<Layer> = {}): Layer => ({
  id: uid(),
  type,
  x: 0,
  y: 0,
  w: 200,
  h: 200,
  rotation: 0,
  opacity: 1,
  blend: 'source-over',
  hidden: false,
  locked: false,
  shadow: { enabled: false, color: '#000000', blur: 12, dx: 6, dy: 6 },
  text: '',
  fontSize: 64,
  fontFamily: FONTS[0]!.value,
  bold: true,
  italic: false,
  align: 'center',
  color: '#ffffff',
  stroke: '#000000',
  strokeWidth: 0,
  fill: '#4f46e5',
  radius: 0,
  shape: 'rect',
  mediaId: null,
  strokes: [],
  ...patch,
});

export function viewSize(doc: ImageDoc): { width: number; height: number } {
  const { width, height } = doc.base;
  return doc.rotation % 180 === 0 ? { width, height } : { width: height, height: width };
}

export function photoSize(doc: ImageDoc): { width: number; height: number } {
  const view = viewSize(doc);
  return {
    width: Math.max(1, Math.round(view.width * (doc.crop?.w ?? 1))),
    height: Math.max(1, Math.round(view.height * (doc.crop?.h ?? 1))),
  };
}

/** Size of the exported picture and where the photo area starts within it. */
export function layout(doc: ImageDoc) {
  const photo = photoSize(doc);
  const border = doc.frame.width;
  const size = (key: SectionKey) => (doc.sections[key].enabled ? doc.sections[key].size : 0);
  const left = size('left');
  const right = size('right');
  const top = size('header') + size('subheader');
  const bottom = size('caption') + size('footer');
  const originX = border + left;
  const originY = border + top;
  const across = left + photo.width + right;
  const strip = (key: SectionKey, y: number) => ({
    key,
    x: border,
    y,
    w: across,
    h: size(key),
    turns: 0 as const,
  });
  const below = originY + photo.height;
  return {
    width: across + border * 2,
    height: top + photo.height + bottom + border * 2,
    originX,
    originY,
    photo,
    /** Where each text section is drawn; hidden ones have no thickness. */
    bands: [
      strip('header', border),
      strip('subheader', border + size('header')),
      {
        key: 'left' as SectionKey,
        x: border,
        y: originY,
        w: left,
        h: photo.height,
        turns: -1 as const,
      },
      {
        key: 'right' as SectionKey,
        x: originX + photo.width,
        y: originY,
        w: right,
        h: photo.height,
        turns: 1 as const,
      },
      strip('caption', below),
      strip('footer', below + size('caption')),
    ],
  };
}

const shiftLayer = (layer: Layer, dx: number, dy: number): Layer => ({
  ...layer,
  x: layer.x + dx,
  y: layer.y + dy,
});

/** Crops to `area` (fractions of the visible photo), keeping layers over the same picture content. */
export function applyCrop(doc: ImageDoc, area: Rect): ImageDoc {
  const crop = doc.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const photo = photoSize(doc);
  return {
    ...doc,
    crop: {
      x: crop.x + area.x * crop.w,
      y: crop.y + area.y * crop.h,
      w: crop.w * area.w,
      h: crop.h * area.h,
    },
    layers: doc.layers.map((l) => shiftLayer(l, -area.x * photo.width, -area.y * photo.height)),
  };
}

export function resetCrop(doc: ImageDoc): ImageDoc {
  if (!doc.crop) return doc;
  const view = viewSize(doc);
  const { x, y } = doc.crop;
  return {
    ...doc,
    crop: null,
    layers: doc.layers.map((l) => shiftLayer(l, x * view.width, y * view.height)),
  };
}

/** Turns the picture a quarter clockwise, carrying crop, flips and layers with it. */
export function rotateQuarter(doc: ImageDoc, clockwise: boolean): ImageDoc {
  const turn: Rotation = clockwise ? 90 : 270;
  const photo = photoSize(doc);
  const next = { width: photo.height, height: photo.width };
  const spin = (x: number, y: number) => {
    const point = toDisplay({ x: x / photo.width, y: y / photo.height }, turn);
    return { x: point.x * next.width, y: point.y * next.height };
  };
  return {
    ...doc,
    rotation: ((doc.rotation + turn) % 360) as Rotation,
    // Flips are applied after rotation on screen, so a quarter turn swaps their axes.
    flipH: doc.flipV,
    flipV: doc.flipH,
    crop: doc.crop ? rectToDisplay(doc.crop, turn) : null,
    layers: doc.layers.map((layer) => {
      if (layer.type !== 'draw')
        return {
          ...layer,
          ...spin(layer.x, layer.y),
          rotation: normalizeAngle(layer.rotation + turn),
        };
      // Freehand points are stored in photo space, so they are turned individually.
      const strokes = layer.strokes.map((stroke) => {
        const points: number[] = [];
        for (let i = 0; i < stroke.points.length; i += 2) {
          const p = spin(stroke.points[i]! + layer.x, stroke.points[i + 1]! + layer.y);
          points.push(p.x, p.y);
        }
        return { ...stroke, points };
      });
      return { ...layer, x: 0, y: 0, strokes };
    }),
  };
}

export const normalizeAngle = (angle: number): number =>
  ((((angle + 180) % 360) + 360) % 360) - 180;

export function flip(doc: ImageDoc, axis: 'h' | 'v'): ImageDoc {
  const crop = doc.crop;
  return {
    ...doc,
    flipH: axis === 'h' ? !doc.flipH : doc.flipH,
    flipV: axis === 'v' ? !doc.flipV : doc.flipV,
    // Mirror the crop so the same part of the picture stays selected.
    crop:
      crop &&
      (axis === 'h' ? { ...crop, x: 1 - crop.x - crop.w } : { ...crop, y: 1 - crop.y - crop.h }),
  };
}

/** Changes the pixel size of a blank canvas, scaling layers to match. */
export function resizeCanvas(doc: ImageDoc, width: number, height: number): ImageDoc {
  const sx = width / doc.base.width;
  const sy = height / doc.base.height;
  const scale = Math.min(sx, sy);
  return {
    ...doc,
    base: { ...doc.base, width, height },
    crop: null,
    layers: doc.layers.map((l) => ({
      ...l,
      x: l.x * sx,
      y: l.y * sy,
      w: l.w * scale,
      h: l.h * scale,
      fontSize: l.fontSize * scale,
      strokes: l.strokes.map((s) => ({
        ...s,
        size: s.size * scale,
        points: s.points.map((v, i) => v * (i % 2 ? sy : sx)),
      })),
    })),
  };
}

/** The topmost visible, unlocked layer under a photo-space point. */
export function hitTest(layers: Layer[], x: number, y: number): Layer | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    if (layer.hidden || layer.locked || layer.type === 'draw') continue;
    const angle = (-layer.rotation * Math.PI) / 180;
    const dx = x - layer.x;
    const dy = y - layer.y;
    const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
    const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
    // Thin shapes such as lines still need a usable target.
    if (
      Math.abs(localX) <= Math.max(layer.w, 20) / 2 &&
      Math.abs(localY) <= Math.max(layer.h, 20) / 2
    )
      return layer;
  }
  return null;
}

/** New size while dragging the corner handle, with the layer's centre held still. */
export function resizeLayer(
  start: Layer,
  dx: number,
  dy: number,
  keepRatio: boolean,
): Partial<Layer> {
  const angle = (-start.rotation * Math.PI) / 180;
  const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
  const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
  let w = clamp(start.w + localX * 2, 10, 10_000);
  let h = clamp(start.h + localY * 2, 4, 10_000);
  if (start.type === 'text' || start.type === 'sticker') {
    const scale = clamp(w / start.w, 8 / start.fontSize, 800 / start.fontSize);
    return { w: start.w * scale, h: start.h * scale, fontSize: start.fontSize * scale };
  }
  if (keepRatio) {
    const scale = Math.max(w / start.w, h / start.h);
    w = start.w * scale;
    h = start.h * scale;
  }
  return { w, h };
}
