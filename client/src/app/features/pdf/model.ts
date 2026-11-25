/**
 * PDF edit model. Positions are fractions (0-1, origin top-left) of the page *before any rotation*,
 * so rotating a page carries its marks with it and zoom never matters.
 */
export type Rotation = 0 | 90 | 180 | 270;

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  w: number;
  h: number;
}

export interface PageRef {
  key: string;
  /** Library id of the PDF this page comes from, or null for a blank page. */
  source: string | null;
  index: number;
  /** Unrotated size in PDF points. */
  width: number;
  height: number;
  /** Rotation stored in the source file, plus the rotation added here. */
  baseRotation: Rotation;
  rotation: Rotation;
}

interface Base {
  id: string;
  page: string;
  color: string;
}

export type Annotation =
  /** Marks made from a text selection. `rot` is how the page was turned, which decides what "under" means. */
  | (Base & {
      type: 'highlight' | 'underline' | 'strike';
      rects: Rect[];
      rot: Rotation;
      text: string;
    })
  | (Base & { type: 'ink'; points: Point[]; width: number; opacity: number })
  | (Base & { type: 'line' | 'arrow'; from: Point; to: Point; width: number })
  | (Base & { type: 'rect' | 'ellipse'; box: Rect; width: number; fill: string })
  | (Base & { type: 'whiteout' | 'redact'; box: Rect })
  /** Upright boxes: centre plus size in points, turned to match the page rotation they were added at. */
  | (Base & {
      type: 'text';
      center: Point;
      w: number;
      h: number;
      rot: Rotation;
      text: string;
      size: number;
      bold: boolean;
    })
  | (Base & { type: 'stamp'; center: Point; w: number; h: number; rot: Rotation; text: string })
  | (Base & { type: 'image'; center: Point; w: number; h: number; rot: Rotation; src: string })
  | (Base & { type: 'comment'; at: Point; text: string });

export type BoxAnnotation = Extract<Annotation, { center: Point }>;

export interface PdfDoc {
  pages: PageRef[];
  annotations: Annotation[];
  watermark: { text: string; color: string; opacity: number; size: number } | null;
  pageNumbers: boolean;
  /** Form values by source id, then field name. */
  forms: Record<string, Record<string, string | boolean>>;
}

export const emptyDoc = (pages: PageRef[] = []): PdfDoc => ({
  pages,
  annotations: [],
  watermark: null,
  pageNumbers: false,
  forms: {},
});

export const totalRotation = (page: PageRef): Rotation =>
  ((page.baseRotation + page.rotation) % 360) as Rotation;
