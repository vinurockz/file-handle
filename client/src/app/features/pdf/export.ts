/** Writes the edit model into a real PDF with pdf-lib. */
import {
  BlendMode,
  degrees,
  LineCapStyle,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import { arrowHead, displaySize, markLine, toPage } from './geometry';
import {
  totalRotation,
  type Annotation,
  type BoxAnnotation,
  type PageRef,
  type PdfDoc,
  type Point,
  type Rect,
} from './model';

export interface Raster {
  png: Uint8Array;
}

export interface ExportHost {
  /** Bytes of a source PDF from the library. */
  sourceBytes(id: string): Promise<Uint8Array>;
  /** Bytes of a picture (data URL or library URL) converted to PNG. */
  imagePng(src: string): Promise<Uint8Array>;
  /** Renders unrotated page `index` of `bytes` to a picture with the boxes painted black. */
  rasterize(bytes: Uint8Array, index: number, boxes: Rect[]): Promise<Raster>;
  /** Draws text the built-in PDF fonts cannot encode (any non-Latin script or emoji). */
  textPng(
    text: string,
    size: number,
    color: string,
    bold: boolean,
    width: number,
    height: number,
  ): Promise<Uint8Array>;
}

export const color = (hex: string) => {
  const value = Number.parseInt(hex.replace('#', ''), 16) || 0;
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
};

export function canEncode(font: PDFFont, text: string): boolean {
  try {
    font.encodeText(text.replace(/[\r\n\t]/g, ' '));
    return true;
  } catch {
    return false;
  }
}

async function loadSource(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes);
  } catch (error) {
    if (/encrypt/i.test((error as Error).message)) {
      throw new Error(
        'This PDF is password protected, so it cannot be edited. Remove the password first.',
      );
    }
    throw new Error('This PDF could not be read. It may be damaged.');
  }
}

/** Fills form fields and flattens them, so values survive page copying. */
function applyForm(document: PDFDocument, values: Record<string, string | boolean>): void {
  const form = document.getForm();
  for (const field of form.getFields()) {
    const value = values[field.getName()];
    if (value === undefined) continue;
    if (field instanceof PDFTextField) field.setText(String(value));
    else if (field instanceof PDFCheckBox) {
      if (value) field.check();
      else field.uncheck();
    } else if (
      field instanceof PDFDropdown ||
      field instanceof PDFOptionList ||
      field instanceof PDFRadioGroup
    ) {
      if (value) field.select(String(value));
    }
  }
  form.flatten();
}

export async function buildPdf(
  model: PdfDoc,
  host: ExportHost,
  only?: ReadonlySet<string>,
): Promise<Uint8Array> {
  const pages = only ? model.pages.filter((p) => only.has(p.key)) : model.pages;
  if (!pages.length) throw new Error('There are no pages to export');
  const output = await PDFDocument.create();
  const fonts = {
    regular: await output.embedFont(StandardFonts.Helvetica),
    bold: await output.embedFont(StandardFonts.HelveticaBold),
  };
  const sources = new Map<string, { document: PDFDocument; bytes: Uint8Array }>();
  const images = new Map<string, PDFImage>();

  const source = async (id: string) => {
    let entry = sources.get(id);
    if (!entry) {
      const original = await host.sourceBytes(id);
      const document = await loadSource(original);
      let bytes = original;
      const values = model.forms[id];
      if (values && Object.keys(values).length) {
        try {
          applyForm(document, values);
          bytes = await document.save();
        } catch (error) {
          throw new Error(`The form could not be filled in: ${(error as Error).message}`);
        }
      }
      entry = { document: await loadSource(bytes), bytes };
      sources.set(id, entry);
    }
    return entry;
  };
  const image = async (src: string) => {
    let embedded = images.get(src);
    if (!embedded) images.set(src, (embedded = await output.embedPng(await host.imagePng(src))));
    return embedded;
  };

  for (const [number, ref] of pages.entries()) {
    const marks = model.annotations.filter((a) => a.page === ref.key);
    const redactions = marks.flatMap((a) => (a.type === 'redact' ? [a.box] : []));
    let page: PDFPage;
    let rasterized = false;
    if (ref.source === null) {
      page = output.addPage([ref.width, ref.height]);
    } else if (redactions.length) {
      // Redacted pages become pictures: the hidden text is genuinely removed from the file.
      const raster = await host.rasterize((await source(ref.source)).bytes, ref.index, redactions);
      page = output.addPage([ref.width, ref.height]);
      page.drawImage(await output.embedPng(raster.png), {
        x: 0,
        y: 0,
        width: ref.width,
        height: ref.height,
      });
      rasterized = true;
    } else {
      const [copied] = await output.copyPages((await source(ref.source)).document, [ref.index]);
      page = output.addPage(copied!);
    }
    page.setRotation(degrees(totalRotation(ref)));

    const box =
      ref.source === null || rasterized
        ? { x: 0, y: 0, width: ref.width, height: ref.height }
        : page.getCropBox();
    const pen = new Pen(page, box, fonts, host, image, output);
    for (const mark of marks) await pen.draw(mark);
    if (model.watermark?.text) await pen.watermark(model.watermark, ref);
    if (model.pageNumbers) pen.pageNumber(`${number + 1} / ${pages.length}`, ref);
  }
  return output.save();
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

class Pen {
  private readonly page: PDFPage;
  private readonly box: Box;
  private readonly fonts: { regular: PDFFont; bold: PDFFont };
  private readonly host: ExportHost;
  private readonly image: (src: string) => Promise<PDFImage>;
  private readonly output: PDFDocument;

  constructor(
    page: PDFPage,
    box: Box,
    fonts: { regular: PDFFont; bold: PDFFont },
    host: ExportHost,
    image: (src: string) => Promise<PDFImage>,
    output: PDFDocument,
  ) {
    this.page = page;
    this.box = box;
    this.fonts = fonts;
    this.host = host;
    this.image = image;
    this.output = output;
  }

  private at(point: Point): Point {
    return {
      x: this.box.x + point.x * this.box.width,
      y: this.box.y + (1 - point.y) * this.box.height,
    };
  }

  private rect(r: Rect) {
    const corner = this.at({ x: r.x, y: r.y + r.h });
    return { x: corner.x, y: corner.y, width: r.w * this.box.width, height: r.h * this.box.height };
  }

  private stroke(points: Point[], hex: string, width: number, opacity = 1): void {
    // SVG path space has y pointing down from the origin we give it.
    const path = points
      .map(
        (p, i) =>
          `${i ? 'L' : 'M'} ${(p.x * this.box.width).toFixed(2)} ${(p.y * this.box.height).toFixed(2)}`,
      )
      .join(' ');
    this.page.drawSvgPath(path, {
      x: this.box.x,
      y: this.box.y + this.box.height,
      borderColor: color(hex),
      borderWidth: width,
      borderOpacity: opacity,
      borderLineCap: LineCapStyle.Round,
    });
  }

  /** Maps a point in a box's upright frame (origin bottom-left, y up) onto the page. */
  private local(
    center: Point,
    w: number,
    h: number,
    rotation: number,
    x: number,
    y: number,
  ): Point {
    const c = this.at(center);
    const angle = (rotation * Math.PI) / 180;
    const dx = x - w / 2;
    const dy = y - h / 2;
    return {
      x: c.x + dx * Math.cos(angle) - dy * Math.sin(angle),
      y: c.y + dx * Math.sin(angle) + dy * Math.cos(angle),
    };
  }

  async draw(mark: Annotation): Promise<void> {
    switch (mark.type) {
      case 'highlight':
        for (const r of mark.rects) {
          this.page.drawRectangle({
            ...this.rect(r),
            color: color(mark.color),
            opacity: 0.45,
            blendMode: BlendMode.Multiply,
          });
        }
        break;
      case 'underline':
      case 'strike':
        for (const r of mark.rects) this.stroke(markLine(r, mark.rot, mark.type), mark.color, 1.2);
        break;
      case 'ink':
        this.stroke(
          mark.points.length === 1 ? [mark.points[0]!, mark.points[0]!] : mark.points,
          mark.color,
          mark.width,
          mark.opacity,
        );
        break;
      case 'line':
        this.stroke([mark.from, mark.to], mark.color, mark.width);
        break;
      case 'arrow': {
        const size = Math.max(8, mark.width * 4);
        const points = (p: Point) => ({ x: p.x * this.box.width, y: p.y * this.box.height });
        const back = (p: Point) => ({ x: p.x / this.box.width, y: p.y / this.box.height });
        const [left, right] = arrowHead(points(mark.from), points(mark.to), size).map(back);
        this.stroke([mark.from, mark.to], mark.color, mark.width);
        this.stroke([left!, mark.to, right!], mark.color, mark.width);
        break;
      }
      case 'rect':
        this.page.drawRectangle({
          ...this.rect(mark.box),
          borderColor: color(mark.color),
          borderWidth: mark.width,
          ...(mark.fill ? { color: color(mark.fill) } : { opacity: 0 }),
          borderOpacity: 1,
        });
        break;
      case 'ellipse': {
        const r = this.rect(mark.box);
        this.page.drawEllipse({
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          xScale: r.width / 2,
          yScale: r.height / 2,
          borderColor: color(mark.color),
          borderWidth: mark.width,
          ...(mark.fill ? { color: color(mark.fill) } : { opacity: 0 }),
          borderOpacity: 1,
        });
        break;
      }
      case 'whiteout':
        this.page.drawRectangle({ ...this.rect(mark.box), color: color(mark.color) });
        break;
      case 'redact':
        this.page.drawRectangle({ ...this.rect(mark.box), color: rgb(0, 0, 0) });
        break;
      case 'comment': {
        const at = this.at(mark.at);
        const annotation = this.output.context.obj({
          Type: PDFName.of('Annot'),
          Subtype: PDFName.of('Text'),
          Rect: [at.x, at.y - 20, at.x + 20, at.y],
          Contents: PDFHexString.fromText(mark.text),
          Name: PDFName.of('Comment'),
          C: [1, 0.85, 0.2],
          Open: false,
        });
        this.page.node.addAnnot(this.output.context.register(annotation));
        break;
      }
      case 'image':
        this.placeImage(await this.image(mark.src), mark);
        break;
      case 'text':
        await this.text(mark);
        break;
      case 'stamp': {
        const corner = this.local(mark.center, mark.w, mark.h, mark.rot, 0, 0);
        this.page.drawRectangle({
          ...corner,
          width: mark.w,
          height: mark.h,
          rotate: degrees(mark.rot),
          borderColor: color(mark.color),
          borderWidth: 2.5,
          opacity: 0,
          borderOpacity: 0.85,
        });
        const size = Math.min(
          mark.h * 0.55,
          (mark.w - 10) / Math.max(1, this.fonts.bold.widthOfTextAtSize(mark.text, 1)),
        );
        const width = this.fonts.bold.widthOfTextAtSize(mark.text, size);
        this.page.drawText(mark.text, {
          ...this.local(
            mark.center,
            mark.w,
            mark.h,
            mark.rot,
            (mark.w - width) / 2,
            mark.h / 2 - size * 0.35,
          ),
          size,
          font: this.fonts.bold,
          color: color(mark.color),
          rotate: degrees(mark.rot),
          opacity: 0.85,
        });
        break;
      }
    }
  }

  private placeImage(
    embedded: PDFImage,
    mark: { center: Point; w: number; h: number; rot: number },
  ): void {
    this.page.drawImage(embedded, {
      ...this.local(mark.center, mark.w, mark.h, mark.rot, 0, 0),
      width: mark.w,
      height: mark.h,
      rotate: degrees(mark.rot),
    });
  }

  private async text(mark: Extract<BoxAnnotation, { type: 'text' }>): Promise<void> {
    const font = mark.bold ? this.fonts.bold : this.fonts.regular;
    if (!canEncode(font, mark.text)) {
      const png = await this.host.textPng(
        mark.text,
        mark.size,
        mark.color,
        mark.bold,
        mark.w,
        mark.h,
      );
      this.placeImage(await this.output.embedPng(png), mark);
      return;
    }
    mark.text
      .replace(/\t/g, '    ')
      .split('\n')
      .forEach((line, i) => {
        if (!line) return;
        this.page.drawText(line, {
          // Baseline matches the on-screen line height of 1.2.
          ...this.local(
            mark.center,
            mark.w,
            mark.h,
            mark.rot,
            2,
            mark.h - mark.size * (1.2 * i + 0.95),
          ),
          size: mark.size,
          font,
          color: color(mark.color),
          rotate: degrees(mark.rot),
        });
      });
  }

  async watermark(mark: NonNullable<PdfDoc['watermark']>, ref: PageRef): Promise<void> {
    const shown = displaySize(this.box.width, this.box.height, totalRotation(ref));
    const angle = totalRotation(ref) + (Math.atan2(shown.height, shown.width) * 180) / Math.PI;
    const font = this.fonts.bold;
    const center = { x: 0.5, y: 0.5 };
    if (!canEncode(font, mark.text)) {
      const w = mark.size * Math.max(2, mark.text.length * 0.7);
      const h = mark.size * 1.4;
      const png = await this.host.textPng(mark.text, mark.size, mark.color, true, w, h);
      this.page.drawImage(await this.output.embedPng(png), {
        ...this.local(center, w, h, angle, 0, 0),
        width: w,
        height: h,
        rotate: degrees(angle),
        opacity: mark.opacity,
      });
      return;
    }
    const width = font.widthOfTextAtSize(mark.text, mark.size);
    this.page.drawText(mark.text, {
      ...this.local(center, width, mark.size * 0.7, angle, 0, 0),
      size: mark.size,
      font,
      color: color(mark.color),
      opacity: mark.opacity,
      rotate: degrees(angle),
    });
  }

  pageNumber(label: string, ref: PageRef): void {
    const rotation = totalRotation(ref);
    const shown = displaySize(this.box.width, this.box.height, rotation);
    const width = this.fonts.regular.widthOfTextAtSize(label, 10);
    const start = toPage({ x: 0.5 - width / 2 / shown.width, y: 1 - 22 / shown.height }, rotation);
    this.page.drawText(label, {
      ...this.at(start),
      size: 10,
      font: this.fonts.regular,
      color: rgb(0.2, 0.2, 0.2),
      rotate: degrees(rotation),
    });
  }
}
