import { degrees, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { buildPdf, type ExportHost } from './export';
import {
  markLine,
  mergeRects,
  moveAnnotation,
  rectToDisplay,
  rectToPage,
  toDisplay,
  toPage,
} from './geometry';
import { emptyDoc, type Annotation, type PageRef, type Rotation } from './model';

const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhWMjWwAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

const page = (key: string, patch: Partial<PageRef> = {}): PageRef => ({
  key,
  source: null,
  index: 0,
  width: 400,
  height: 600,
  baseRotation: 0,
  rotation: 0,
  ...patch,
});

async function sourcePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const label of ['one', 'two'])
    pdf.addPage([400, 600]).drawText(label, { x: 50, y: 500, font });
  const field = pdf.getForm().createTextField('name');
  field.addToPage(pdf.getPage(0), { x: 50, y: 100, width: 200, height: 20 });
  return pdf.save();
}

function host(bytes: Uint8Array) {
  const calls = { rasterized: [] as number[], textImages: [] as string[] };
  const fake: ExportHost = {
    sourceBytes: async () => bytes,
    imagePng: async () => PNG,
    rasterize: async (_b, index) => {
      calls.rasterized.push(index);
      return { png: PNG };
    },
    textPng: async (text) => {
      calls.textImages.push(text);
      return PNG;
    },
  };
  return { fake, calls };
}

describe('PDF geometry', () => {
  it('round-trips points and rectangles through every rotation', () => {
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      const point = toPage(toDisplay({ x: 0.2, y: 0.7 }, rotation), rotation);
      expect(point.x).toBeCloseTo(0.2);
      expect(point.y).toBeCloseTo(0.7);
      const rect = rectToPage(
        rectToDisplay({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, rotation),
        rotation,
      );
      expect(rect.x).toBeCloseTo(0.1);
      expect(rect.h).toBeCloseTo(0.4);
    }
  });

  it('turns clockwise: the top-left corner moves to the top-right', () => {
    expect(toDisplay({ x: 0, y: 0 }, 90)).toEqual({ x: 1, y: 0 });
  });

  it('underlines along the bottom as the reader sees it', () => {
    const [a, b] = markLine({ x: 0.2, y: 0.2, w: 0.1, h: 0.4 }, 90, 'underline');
    expect(toDisplay(a, 90).y).toBeCloseTo(toDisplay(b, 90).y);
    expect(toDisplay(a, 90).y).toBeGreaterThan(
      rectToDisplay({ x: 0.2, y: 0.2, w: 0.1, h: 0.4 }, 90).y,
    );
  });

  it('merges the pieces of one line but not separate lines', () => {
    const merged = mergeRects([
      { x: 0.1, y: 0.1, w: 0.2, h: 0.02 },
      { x: 0.3, y: 0.1005, w: 0.1, h: 0.02 },
      { x: 0.1, y: 0.2, w: 0.2, h: 0.02 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.w).toBeCloseTo(0.3);
  });

  it('moves every kind of annotation', () => {
    const moved = moveAnnotation(
      {
        id: '1',
        page: 'p',
        color: '#000000',
        type: 'ink',
        width: 1,
        opacity: 1,
        points: [{ x: 0.1, y: 0.1 }],
      },
      0.1,
      0.2,
    );
    expect(moved.type === 'ink' && moved.points[0]!.y).toBeCloseTo(0.3);
  });
});

describe('PDF export', () => {
  const base = { page: 'p1', color: '#ff0000' };
  const every: Annotation[] = [
    {
      ...base,
      id: 'a',
      type: 'highlight',
      rects: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.03 }],
      rot: 0,
      text: 'x',
    },
    {
      ...base,
      id: 'b',
      type: 'underline',
      rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.03 }],
      rot: 0,
      text: 'x',
    },
    {
      ...base,
      id: 'c',
      type: 'strike',
      rects: [{ x: 0.1, y: 0.3, w: 0.3, h: 0.03 }],
      rot: 90,
      text: 'x',
    },
    {
      ...base,
      id: 'd',
      type: 'ink',
      points: [
        { x: 0.1, y: 0.4 },
        { x: 0.5, y: 0.45 },
      ],
      width: 2,
      opacity: 0.5,
    },
    { ...base, id: 'e', type: 'ink', points: [{ x: 0.5, y: 0.5 }], width: 4, opacity: 1 },
    { ...base, id: 'f', type: 'line', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, width: 1 },
    { ...base, id: 'g', type: 'arrow', from: { x: 0.2, y: 0.2 }, to: { x: 0.8, y: 0.2 }, width: 3 },
    { ...base, id: 'h', type: 'rect', box: { x: 0.2, y: 0.6, w: 0.2, h: 0.1 }, width: 2, fill: '' },
    {
      ...base,
      id: 'i',
      type: 'ellipse',
      box: { x: 0.5, y: 0.6, w: 0.2, h: 0.1 },
      width: 2,
      fill: '#00ff00',
    },
    { ...base, id: 'j', type: 'whiteout', box: { x: 0.1, y: 0.8, w: 0.2, h: 0.05 } },
    {
      ...base,
      id: 'k',
      type: 'text',
      center: { x: 0.5, y: 0.9 },
      w: 100,
      h: 20,
      rot: 90,
      text: 'Hello\nworld',
      size: 14,
      bold: true,
    },
    {
      ...base,
      id: 'l',
      type: 'stamp',
      center: { x: 0.5, y: 0.5 },
      w: 160,
      h: 40,
      rot: 0,
      text: 'APPROVED',
    },
    {
      ...base,
      id: 'm',
      type: 'image',
      center: { x: 0.3, y: 0.3 },
      w: 80,
      h: 40,
      rot: 180,
      src: 'data:x',
    },
    { ...base, id: 'n', type: 'comment', at: { x: 0.5, y: 0.1 }, text: 'ध्यान दें — review' },
  ];

  it('writes every annotation type, watermark and page numbers', async () => {
    const { fake, calls } = host(await sourcePdf());
    const bytes = await buildPdf(
      {
        ...emptyDoc([page('p1'), page('p2', { rotation: 90 })]),
        annotations: every,
        pageNumbers: true,
        watermark: { text: 'DRAFT', color: '#999999', opacity: 0.2, size: 60 },
      },
      fake,
    );
    const output = await PDFDocument.load(bytes);
    expect(output.getPageCount()).toBe(2);
    expect(output.getPage(1).getRotation()).toEqual(degrees(90));
    expect(output.getPage(0).node.Annots()?.size()).toBe(1);
    expect(output.getPage(0).node.get(PDFName.of('Contents'))).toBeTruthy();
    expect(calls.textImages).toEqual([]);
  });

  it('draws text in scripts the built-in fonts lack as an image', async () => {
    const { fake, calls } = host(await sourcePdf());
    await buildPdf(
      {
        ...emptyDoc([page('p1')]),
        annotations: [
          {
            ...base,
            id: 't',
            type: 'text',
            center: { x: 0.5, y: 0.5 },
            w: 100,
            h: 20,
            rot: 0,
            text: 'नमस्ते 👋',
            size: 14,
            bold: false,
          },
        ],
        watermark: { text: 'गोपनीय', color: '#999999', opacity: 0.2, size: 40 },
      },
      fake,
    );
    expect(calls.textImages).toEqual(['नमस्ते 👋', 'गोपनीय']);
  });

  it('reorders, duplicates, extracts and fills forms', async () => {
    const { fake } = host(await sourcePdf());
    const pages = [
      page('b', { source: 's', index: 1 }),
      page('a', { source: 's', index: 0 }),
      page('c', { source: 's', index: 0 }),
    ];
    const doc = { ...emptyDoc(pages), forms: { s: { name: 'Vineeth' } } };
    const all = await PDFDocument.load(await buildPdf(doc, fake));
    expect(all.getPageCount()).toBe(3);
    expect(all.getForm().getFields()).toHaveLength(0);
    const one = await PDFDocument.load(await buildPdf(doc, fake, new Set(['a'])));
    expect(one.getPageCount()).toBe(1);
  });

  it('rasterizes only pages that have redactions', async () => {
    const { fake, calls } = host(await sourcePdf());
    await buildPdf(
      {
        ...emptyDoc([page('p1', { source: 's', index: 1 }), page('p2', { source: 's', index: 0 })]),
        annotations: [{ ...base, id: 'r', type: 'redact', box: { x: 0, y: 0, w: 1, h: 0.5 } }],
      },
      fake,
    );
    expect(calls.rasterized).toEqual([1]);
  });

  it('refuses to export nothing', async () => {
    await expect(buildPdf(emptyDoc([]), host(new Uint8Array()).fake)).rejects.toThrow('no pages');
  });
});
