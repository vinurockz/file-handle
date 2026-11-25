/** A coloured strip with its own text: the image editor's sections and a movie's title bars. */
export interface Band {
  enabled: boolean;
  text: string;
  /** Thickness in pixels: height for horizontal strips, width for side strips. */
  size: number;
  background: string;
  color: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  align: 'left' | 'center' | 'right';
  borderWidth: number;
  borderColor: string;
  opacity: number;
}

export const createBand = (patch: Partial<Band> = {}): Band => ({
  enabled: false,
  text: '',
  size: 90,
  background: '#111827',
  color: '#ffffff',
  fontSize: 40,
  fontFamily: 'system-ui, Arial, sans-serif',
  bold: true,
  italic: false,
  uppercase: false,
  align: 'center',
  borderWidth: 0,
  borderColor: '#ffffff',
  opacity: 1,
  ...patch,
});

/**
 * Draws a strip into a rectangle. `turns` of -1 or 1 rotates the text a quarter turn so that
 * side strips carry it along their long edge.
 */
export function drawBand(
  g: CanvasRenderingContext2D,
  band: Band,
  x: number,
  y: number,
  w: number,
  h: number,
  turns: -1 | 0 | 1 = 0,
): void {
  if (!band.enabled || w <= 0 || h <= 0) return;
  g.save();
  g.globalAlpha *= band.opacity;
  g.fillStyle = band.background;
  g.fillRect(x, y, w, h);
  if (band.borderWidth > 0) {
    const border = Math.min(band.borderWidth, w / 2, h / 2);
    g.strokeStyle = band.borderColor;
    g.lineWidth = border;
    g.strokeRect(x + border / 2, y + border / 2, w - border, h - border);
  }
  if (band.text) {
    const length = turns === 0 ? w : h;
    const inset = band.borderWidth + Math.max(8, band.fontSize * 0.4);
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.translate(x + w / 2, y + h / 2);
    g.rotate((turns * Math.PI) / 2);
    g.font = `${band.italic ? 'italic ' : ''}${band.bold ? 'bold ' : ''}${band.fontSize}px ${band.fontFamily}`;
    g.fillStyle = band.color;
    g.textAlign = band.align;
    g.textBaseline = 'middle';
    const at =
      band.align === 'left' ? -length / 2 + inset : band.align === 'right' ? length / 2 - inset : 0;
    const lines = (band.uppercase ? band.text.toUpperCase() : band.text).split('\n');
    lines.forEach((line, i) =>
      g.fillText(line, at, (i - (lines.length - 1) / 2) * band.fontSize * 1.2, length - inset * 2),
    );
  }
  g.restore();
}
