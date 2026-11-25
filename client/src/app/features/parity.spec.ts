import { dragCrop } from './books/crop-modal';
import { paginate, type TranscriptBlock } from './chat/chat-pdf';
import { folderSummaries } from './files/library-utils';
import { emptyImageDoc, layout, rotateQuarter } from './image/model';
import { sizeForPhoto } from './image/sections';
import { freehand, magicWand, resizeBounds } from './image/selection';
import { movieBand } from './movies/model';
import { createClip, emptyVideoDoc, toSpec, type Clip } from './video/timeline';
import { createBlock, isWebAddress, mapSource, renderBlocks } from './website/blocks';
import { moveBlock, placeBlock, syncTabs } from './website/drag';
import { buildSite, collectMedia, findBlock } from './website/site';

/** A 4x3 picture: the left two columns are red, the rest blue. */
function twoColours(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(4 * 3 * 4);
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++)
      data.set(x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 4 + x) * 4);
  }
  return data;
}

describe('lasso selections', () => {
  it('magic wand takes only the connected area of a similar colour', () => {
    const selection = magicWand(twoColours(), 4, 3, 0, 0, 10)!;
    expect(selection.bounds).toEqual({ x: 0, y: 0, w: 2, h: 3 });
    expect([...selection.mask!].filter(Boolean)).toHaveLength(6);
    // Even the widest tolerance keeps strongly different colours apart.
    expect(magicWand(twoColours(), 4, 3, 0, 0, 100)!.bounds.w).toBe(2);
    const shades = twoColours().map((v, i) => (i % 4 === 2 && v === 255 ? 60 : v));
    expect(magicWand(shades, 4, 3, 0, 0, 100)!.bounds.w).toBe(4);
    expect(magicWand(twoColours(), 4, 3, 9, 0, 10)).toBeNull();
  });

  it('rejects a freehand shape that is too small, and keeps resized boxes inside the picture', () => {
    expect(
      freehand(
        [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
          { x: 1, y: 2 },
        ],
        100,
        100,
      ),
    ).toBeNull();
    const shape = freehand(
      [
        { x: -5, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 60 },
      ],
      40,
      40,
    )!;
    expect(shape.bounds).toEqual({ x: 0, y: 0, w: 40, h: 40 });
    expect(resizeBounds({ x: 10, y: 10, w: 20, h: 20 }, 'nw', { x: 999, y: -5 }, 100, 100)).toEqual(
      { x: 26, y: 0, w: 4, h: 30 },
    );
  });
});

describe('image sections', () => {
  const withAll = () => {
    const doc = emptyImageDoc(1000, 500);
    for (const key of Object.keys(doc.sections) as (keyof typeof doc.sections)[]) {
      doc.sections[key] = { ...doc.sections[key], enabled: true, size: 10 };
    }
    return doc;
  };

  it('stacks all six sections around the photo', () => {
    const box = layout(withAll());
    expect(box).toMatchObject({ width: 1020, height: 540, originX: 10, originY: 20 });
    expect(box.bands.map((b) => [b.key, b.y])).toEqual([
      ['header', 0],
      ['subheader', 10],
      ['left', 20],
      ['right', 20],
      ['caption', 520],
      ['footer', 530],
    ]);
    expect(box.bands.find((b) => b.key === 'right')).toMatchObject({ x: 1010, h: 500, turns: 1 });
    // Rotating the photo keeps the sections where they are.
    expect(layout(rotateQuarter(withAll(), true))).toMatchObject({ width: 520, height: 1040 });
  });

  it('sizes a section from the photo only the first time', () => {
    const band = emptyImageDoc().sections.header;
    const sized = sizeForPhoto('header', band, 1000);
    expect(sized.size).toBe(120);
    expect(sizeForPhoto('header', { ...sized, size: 33 }, 1000).size).toBe(33);
    expect(movieBand({ enabled: true, text: 'old title' })).toMatchObject({
      size: 90,
      bold: true,
      text: 'old title',
    });
  });
});

describe('video effects', () => {
  it('sends neutral values for projects saved before the new effects existed', () => {
    const clip = createClip('m', 'video', 5) as Partial<Clip>;
    for (const key of ['hue', 'sepia', 'invert', 'pixelate', 'vignette'] as const) delete clip[key];
    const { spec } = toSpec({ ...emptyVideoDoc(), clips: [clip as Clip] }, 't');
    expect(spec.clips[0]).toMatchObject({
      hue: 0,
      sepia: 0,
      invert: false,
      pixelate: 0,
      vignette: 0,
    });
  });
});

describe('folders, crop and chat PDF', () => {
  const folder = (id: string, parent: string | null) => ({
    id,
    name: id,
    color: '',
    folderParentId: parent,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
  });
  const media = (
    id: string,
    folderId: string,
    kind: 'image' | 'video' | 'pdf',
    createdAt: number,
  ) => ({ id, folderId, kind, title: id, mime: '', size: 1, createdAt, updatedAt: 0 });

  it('counts nested files and prefers a picture as the folder cover', () => {
    const summaries = folderSummaries(
      [folder('a', null), folder('b', 'a')],
      [
        media('v', 'a', 'video', 9),
        media('old', 'b', 'image', 1),
        media('new', 'b', 'image', 2),
        media('doc', 'b', 'pdf', 50),
      ],
    );
    expect(summaries.get('a')!.count).toBe(4);
    expect(summaries.get('a')!.cover!.id).toBe('new');
  });

  it('keeps a dragged crop box inside the picture', () => {
    expect(dragCrop({ x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, 1, -1, 'move')).toEqual({
      x: 0.6,
      y: 0,
      w: 0.4,
      h: 0.4,
    });
    expect(dragCrop({ x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, 1, -1, 'resize')).toMatchObject({
      w: 0.5,
      h: 0.05,
    });
  });

  it('continues a long message across pages without losing lines', () => {
    const block = (count: number): TranscriptBlock => ({
      mine: false,
      name: 'n',
      color: '#000',
      time: '',
      lines: Array.from({ length: count }, (_, i) => String(i)),
      height: count * 20 + 52,
    });
    const pages = paginate([block(2), block(60), block(1)], 400);
    expect(pages.flat().flatMap((b) => b.lines)).toHaveLength(63);
    expect(pages.every((page) => page.reduce((sum, b) => sum + b.height, 0) <= 400)).toBe(true);
    expect(paginate([], 400)).toHaveLength(1);
  });
});

describe('website drag and drop', () => {
  const setup = () => {
    const a = createBlock('heading');
    const b = createBlock('button');
    const columns = createBlock('columns');
    return { a, b, columns, blocks: [columns, a, b] };
  };
  const ids = (blocks: { id: string }[]) => blocks.map((x) => x.id);

  it('places before, after, into a column and at the end, at any depth', () => {
    const { a, b, columns, blocks } = setup();
    const added = createBlock('spacer');
    expect(ids(placeBlock(blocks, added, { kind: 'before', id: a.id }))).toEqual([
      columns.id,
      added.id,
      a.id,
      b.id,
    ]);
    expect(ids(placeBlock(blocks, added, { kind: 'after', id: a.id }))).toEqual([
      columns.id,
      a.id,
      added.id,
      b.id,
    ]);
    expect(ids(placeBlock(blocks, added, { kind: 'end' })).at(-1)).toBe(added.id);
    const nested = placeBlock([columns, b], a, { kind: 'column', parentId: columns.id, column: 1 });
    const inner = placeBlock(nested, added, { kind: 'before', id: a.id });
    expect(ids(findBlock(inner, columns.id)!.columns![1]!)).toEqual([added.id, a.id]);
  });

  it('moves blocks but never into themselves', () => {
    const { a, b, columns, blocks } = setup();
    expect(ids(moveBlock(blocks, b.id, { kind: 'before', id: columns.id }))).toEqual([
      b.id,
      columns.id,
      a.id,
    ]);
    expect(moveBlock(blocks, columns.id, { kind: 'column', parentId: columns.id, column: 0 })).toBe(
      blocks,
    );
    expect(moveBlock(blocks, a.id, { kind: 'after', id: a.id })).toBe(blocks);
    const moved = moveBlock(blocks, a.id, { kind: 'column', parentId: columns.id, column: 0 });
    expect(ids(moved)).toEqual([columns.id, b.id]);
    expect(findBlock(moved, a.id)).toBeTruthy();
  });

  it('keeps each tab’s blocks with that tab', () => {
    const tabs = createBlock('tabs');
    const child = createBlock('heading', { text: 'Inside second tab' });
    const filled = { ...tabs, columns: [[], [child]] };
    const items = tabs.props['items'] as { key: string }[];
    expect(syncTabs(filled, [items[1]!, items[0]!]).columns).toEqual([[child], []]);
    expect(syncTabs(filled, [items[1]!]).columns).toEqual([[child]]);
    expect(syncTabs(filled, [...items, { key: 'new' }]).columns).toEqual([[], [child], []]);
    expect(
      renderBlocks([filled], { editing: false, mediaSrc: (x) => x, pageHref: (x) => x }),
    ).toContain('Inside second tab');
  });

  it('accepts only safe web addresses and Google map embeds', () => {
    const context = {
      editing: false,
      mediaSrc: (id: string) => `lib/${id}`,
      pageHref: (x: string) => x,
    };
    expect(isWebAddress('https://example.com/a.png')).toBe(true);
    expect(isWebAddress('http://example.com/a.png')).toBe(false);
    expect(isWebAddress('javascript:alert(1)')).toBe(false);
    const html = renderBlocks(
      [createBlock('hero', { background: "https://x.example/a.png');evil('" })],
      context,
    );
    const style = new DOMParser()
      .parseFromString(html, 'text/html')
      .querySelector('section')!
      .getAttribute('style')!;
    expect(style).toContain("url('https://x.example/a.png%27%29;evil%28%27')");
    expect(mapSource('https://www.google.com/maps/embed?pb=!1m18', 'x', 5)).toContain('pb=!1m18');
    expect(mapSource('https://evil.example/maps/embed?x=1', 'Hyderabad', 5)).toContain(
      'maps.google.com/maps?q=Hyderabad',
    );
    expect([
      ...collectMedia([
        {
          title: 't',
          slug: 's',
          seoDescription: '',
          blocks: [createBlock('image', { media: 'https://x.example/p.png' })],
        },
      ]),
    ]).toEqual([]);
  });

  it('adds the browser icon to exported pages', () => {
    const theme = {
      name: 'S',
      themeColor: '#000000',
      fontFamily: 'serif',
      textColor: '#000000',
      backgroundColor: '#ffffff',
      faviconMediaId: 'icon',
    };
    const files = buildSite(
      theme,
      [{ title: 'Home', slug: 'home', seoDescription: '', blocks: [] }],
      new Map([['icon', 'icon.png']]),
    );
    expect(files.get('index.html')).toContain('<link rel="icon" href="assets/icon.png">');
  });
});
