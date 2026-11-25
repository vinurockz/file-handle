/** Pure timeline model. Clip times are seconds in the source file; timeline times are seconds in the output. */
import { clamp, uid } from '../../core/util';
import { wrapText } from '../image/text-layout';

export interface Clip {
  id: string;
  mediaId: string;
  kind: 'video' | 'image';
  /** Length of the source file; for pictures, the longest they may be shown. */
  sourceDuration: number;
  start: number;
  end: number;
  speed: number;
  volume: number;
  muted: boolean;
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  /** Margins cut from each edge, as percentages. */
  cut: { top: number; right: number; bottom: number; left: number };
  brightness: number;
  contrast: number;
  saturation: number;
  grayscale: boolean;
  blur: number;
  hue: number;
  sepia: number;
  invert: boolean;
  /** Block size in output pixels; 0 is off. */
  pixelate: number;
  vignette: number;
}

export interface Overlay {
  id: string;
  text: string;
  start: number;
  end: number;
  /** Centre of the text, as fractions of the frame. */
  x: number;
  y: number;
  /** Font size as a fraction of the frame height. */
  size: number;
  color: string;
  outline: string;
  background: string;
  fontFamily: string;
}

export interface VideoDoc {
  clips: Clip[];
  overlays: Overlay[];
  music: { mediaId: string; volume: number } | null;
  width: number;
  height: number;
  fps: number;
  format: 'mp4' | 'webm' | 'gif' | 'mp3';
  quality: 'low' | 'medium' | 'high';
  fadeIn: number;
  fadeOut: number;
}

export const MIN_LENGTH = 0.1;
export const IMAGE_MAX = 600;

export const FRAME_SIZES = [
  { label: 'Landscape 720p', width: 1280, height: 720 },
  { label: 'Landscape 1080p', width: 1920, height: 1080 },
  { label: 'Portrait 9:16', width: 720, height: 1280 },
  { label: 'Square', width: 1080, height: 1080 },
  { label: 'Classic 4:3', width: 960, height: 720 },
  { label: 'Small 480p', width: 854, height: 480 },
];

export const emptyVideoDoc = (): VideoDoc => ({
  clips: [],
  overlays: [],
  music: null,
  width: 1280,
  height: 720,
  fps: 30,
  format: 'mp4',
  quality: 'medium',
  fadeIn: 0,
  fadeOut: 0,
});

export const createClip = (mediaId: string, kind: Clip['kind'], duration: number): Clip => ({
  id: uid(),
  mediaId,
  kind,
  sourceDuration: kind === 'image' ? IMAGE_MAX : duration,
  start: 0,
  end: kind === 'image' ? 3 : duration,
  speed: 1,
  volume: 1,
  muted: false,
  rotate: 0,
  flipH: false,
  flipV: false,
  cut: { top: 0, right: 0, bottom: 0, left: 0 },
  brightness: 0,
  contrast: 1,
  saturation: 1,
  grayscale: false,
  blur: 0,
  hue: 0,
  sepia: 0,
  invert: false,
  pixelate: 0,
  vignette: 0,
});

export const clipLength = (clip: Clip): number => (clip.end - clip.start) / clip.speed;
export const totalLength = (clips: Clip[]): number =>
  clips.reduce((sum, c) => sum + clipLength(c), 0);
export const offsetOf = (clips: Clip[], index: number): number =>
  totalLength(clips.slice(0, index));

/** Which clip is on screen at timeline time `time`, and where in its source that is. */
export function locate(clips: Clip[], time: number): { index: number; sourceTime: number } | null {
  if (!clips.length) return null;
  let offset = 0;
  for (const [index, clip] of clips.entries()) {
    const length = clipLength(clip);
    if (time < offset + length - 1e-6)
      return { index, sourceTime: clip.start + Math.max(0, time - offset) * clip.speed };
    offset += length;
  }
  const last = clips.length - 1;
  return { index: last, sourceTime: clips[last]!.end };
}

/** Cuts the clip under the playhead in two. Returns the input unchanged if either half would be too short. */
export function splitAt(clips: Clip[], time: number): Clip[] {
  const at = locate(clips, time);
  if (!at) return clips;
  const clip = clips[at.index]!;
  if (at.sourceTime - clip.start < MIN_LENGTH || clip.end - at.sourceTime < MIN_LENGTH)
    return clips;
  const first = { ...clip, end: at.sourceTime };
  const second = { ...clip, id: uid(), start: at.sourceTime, cut: { ...clip.cut } };
  return [...clips.slice(0, at.index), first, second, ...clips.slice(at.index + 1)];
}

/** Applies new trim points, keeping them ordered, inside the source and at least the minimum apart. */
export function trim(clip: Clip, start: number, end: number): Clip {
  const limit = clip.sourceDuration;
  const gap = Math.min(MIN_LENGTH, limit);
  if (start !== clip.start) {
    const from = clamp(start, 0, clip.end - gap);
    return { ...clip, start: from };
  }
  return { ...clip, end: clamp(end, clip.start + gap, limit) };
}

export function cropOf(clip: Clip): { x: number; y: number; w: number; h: number } | null {
  const { top, right, bottom, left } = clip.cut;
  if (!top && !right && !bottom && !left) return null;
  return {
    x: left / 100,
    y: top / 100,
    w: (100 - left - right) / 100,
    h: (100 - top - bottom) / 100,
  };
}

/** The request body for the export service, plus the overlays that actually appear. */
export function toSpec(doc: VideoDoc, title: string) {
  const length = totalLength(doc.clips);
  const visible = doc.overlays.filter((o) => o.text.trim() && o.start < length && o.end > o.start);
  return {
    overlays: visible,
    spec: {
      title: title.slice(0, 200) || 'Edited video',
      width: doc.width,
      height: doc.height,
      fps: doc.format === 'gif' ? Math.min(doc.fps, 15) : doc.fps,
      format: doc.format,
      quality: doc.quality,
      fadeIn: doc.fadeIn,
      fadeOut: doc.fadeOut,
      music: doc.music,
      overlays:
        doc.format === 'mp3'
          ? []
          : visible.map((o) => ({ start: o.start, end: Math.min(o.end, length) })),
      clips: doc.clips.map((c) => ({
        mediaId: c.mediaId,
        start: c.start,
        end: c.end,
        speed: c.speed,
        volume: c.volume,
        muted: c.muted,
        rotate: c.rotate,
        flipH: c.flipH,
        flipV: c.flipV,
        crop: cropOf(c),
        brightness: c.brightness,
        contrast: c.contrast,
        saturation: c.saturation,
        grayscale: c.grayscale,
        blur: c.blur,
        // Projects saved before these effects existed do not have them.
        hue: c.hue ?? 0,
        sepia: c.sepia ?? 0,
        invert: c.invert ?? false,
        pixelate: c.pixelate ?? 0,
        vignette: c.vignette ?? 0,
      })),
    },
  };
}

/** Draws one text overlay. The preview and the exported PNG both use this, so they match. */
export function drawOverlay(
  g: CanvasRenderingContext2D,
  overlay: Overlay,
  width: number,
  height: number,
): void {
  const size = overlay.size * height;
  g.save();
  g.font = `bold ${size}px ${overlay.fontFamily}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lines = wrapText(overlay.text, width * 0.92, (t) => g.measureText(t).width);
  const step = size * 1.2;
  const x = overlay.x * width;
  const top = overlay.y * height - ((lines.length - 1) * step) / 2;
  if (overlay.background) {
    const widest = Math.max(...lines.map((l) => g.measureText(l).width));
    g.fillStyle = overlay.background;
    g.beginPath();
    g.roundRect(
      x - widest / 2 - size * 0.4,
      top - step / 2 - size * 0.15,
      widest + size * 0.8,
      lines.length * step + size * 0.3,
      size * 0.25,
    );
    g.fill();
  }
  lines.forEach((line, i) => {
    if (overlay.outline) {
      g.lineJoin = 'round';
      g.lineWidth = Math.max(2, size / 7);
      g.strokeStyle = overlay.outline;
      g.strokeText(line, x, top + i * step);
    }
    g.fillStyle = overlay.color;
    g.fillText(line, x, top + i * step);
  });
  g.restore();
}
