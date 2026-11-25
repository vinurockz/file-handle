import { clamp } from '../../core/util';
import type { Annotation, Point, Rect, Rotation } from './model';

/** Where a point of the unrotated page appears once the page is turned clockwise by `rotation`. */
export function toDisplay({ x, y }: Point, rotation: Rotation): Point {
  switch (rotation) {
    case 90:
      return { x: 1 - y, y: x };
    case 180:
      return { x: 1 - x, y: 1 - y };
    case 270:
      return { x: y, y: 1 - x };
    default:
      return { x, y };
  }
}

/** Inverse of `toDisplay`: converts a point the user sees back onto the unrotated page. */
export function toPage(point: Point, rotation: Rotation): Point {
  return toDisplay(point, ((360 - rotation) % 360) as Rotation);
}

export function rectFrom(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

const corners = (r: Rect) =>
  [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
  ] as const;

export function rectToDisplay(rect: Rect, rotation: Rotation): Rect {
  const [a, b] = corners(rect);
  return rectFrom(toDisplay(a, rotation), toDisplay(b, rotation));
}

export function rectToPage(rect: Rect, rotation: Rotation): Rect {
  const [a, b] = corners(rect);
  return rectFrom(toPage(a, rotation), toPage(b, rotation));
}

export const displaySize = (width: number, height: number, rotation: Rotation) =>
  rotation % 180 === 0 ? { width, height } : { width: height, height: width };

/** The underline or strike-through segment for one selected rectangle, in page coordinates. */
export function markLine(
  rect: Rect,
  rotation: Rotation,
  kind: 'underline' | 'strike',
): [Point, Point] {
  const shown = rectToDisplay(rect, rotation);
  const y = shown.y + shown.h * (kind === 'underline' ? 0.93 : 0.55);
  return [toPage({ x: shown.x, y }, rotation), toPage({ x: shown.x + shown.w, y }, rotation)];
}

/** Joins the many small boxes a text selection produces into one box per line. */
export function mergeRects(rects: Rect[]): Rect[] {
  const result: Rect[] = [];
  for (const rect of [...rects]
    .filter((r) => r.w > 0.0005 && r.h > 0.0005)
    .sort((a, b) => a.y - b.y || a.x - b.x)) {
    const match = result.find((other) => {
      const overlap = Math.min(other.y + other.h, rect.y + rect.h) - Math.max(other.y, rect.y);
      const gap = Math.max(other.x, rect.x) - Math.min(other.x + other.w, rect.x + rect.w);
      return overlap > Math.min(other.h, rect.h) * 0.6 && gap < Math.min(other.h, rect.h);
    });
    if (!match) {
      result.push({ ...rect });
      continue;
    }
    const x = Math.min(match.x, rect.x);
    const y = Math.min(match.y, rect.y);
    match.w = Math.max(match.x + match.w, rect.x + rect.w) - x;
    match.h = Math.max(match.y + match.h, rect.y + rect.h) - y;
    match.x = x;
    match.y = y;
  }
  return result;
}

/** Arrow-head barbs, computed in points so the angle stays true on non-square pages. */
export function arrowHead(from: Point, to: Point, size: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const barb = (offset: number) => ({
    x: to.x - size * Math.cos(angle + offset),
    y: to.y - size * Math.sin(angle + offset),
  });
  return [barb(Math.PI / 7), barb(-Math.PI / 7)];
}

/** Returns a copy of the annotation shifted by a page-fraction offset. */
export function moveAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  const point = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
  const rect = (r: Rect) => ({ ...r, x: r.x + dx, y: r.y + dy });
  switch (a.type) {
    case 'highlight':
    case 'underline':
    case 'strike':
      return { ...a, rects: a.rects.map(rect) };
    case 'ink':
      return { ...a, points: a.points.map(point) };
    case 'line':
    case 'arrow':
      return { ...a, from: point(a.from), to: point(a.to) };
    case 'rect':
    case 'ellipse':
    case 'whiteout':
    case 'redact':
      return { ...a, box: rect(a.box) };
    case 'comment':
      return { ...a, at: { x: clamp(a.at.x + dx, 0, 1), y: clamp(a.at.y + dy, 0, 1) } };
    default:
      return { ...a, center: { x: clamp(a.center.x + dx, 0, 1), y: clamp(a.center.y + dy, 0, 1) } };
  }
}
