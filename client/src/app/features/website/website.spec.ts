import { BLOCKS, createBlock, embedUrl, renderBlocks, safeUrl, styleCss } from './blocks';
import {
  buildSite,
  collectMedia,
  duplicateBlock,
  findBlock,
  insertAfter,
  insertIntoColumn,
  removeBlock,
  setColumnCount,
  shiftBlock,
  siteCss,
  TEMPLATES,
  uniqueSlug,
  type PageData,
} from './site';
import type { RenderContext } from './types';

const context: RenderContext = {
  editing: false,
  mediaSrc: (id) => `m/${id}`,
  pageHref: (slug) => `${slug}.html`,
};
const theme = {
  name: 'Site',
  themeColor: '#123456',
  fontFamily: 'serif',
  textColor: '#000000',
  backgroundColor: '#ffffff',
};
const ATTACK = '"><img src=x onerror=alert(1)><script>alert(1)</script>';

/** Fills every text setting of a block with a script-injection attempt. */
function poisoned(value: unknown): unknown {
  if (typeof value === 'string') return ATTACK;
  if (Array.isArray(value)) return value.map(poisoned);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, poisoned(v)]));
  return value;
}

describe('website blocks', () => {
  it('renders every block with its defaults', () => {
    for (const def of BLOCKS) {
      const html = renderBlocks([createBlock(def.kind)], { ...context, editing: true });
      expect(html, def.kind).toContain('data-block-id');
    }
  });

  it('never lets block text create elements, attributes or script links', () => {
    // Custom HTML is the one block that is meant to hold markup; it is checked separately.
    for (const def of BLOCKS.filter((d) => d.kind !== 'customHtml')) {
      const block = createBlock(def.kind);
      block.props = poisoned(block.props) as typeof block.props;
      block.style = {
        color: ATTACK,
        background: 'red;}</style><script>',
        borderColor: ATTACK,
        borderWidth: 1,
      };
      const parsed = new DOMParser().parseFromString(renderBlocks([block], context), 'text/html');
      expect(parsed.querySelectorAll('script').length, def.kind).toBe(0);
      const handlers = [...parsed.querySelectorAll('*')].flatMap((el) =>
        [...el.attributes].filter((a) => a.name.startsWith('on')),
      );
      expect(handlers, def.kind).toEqual([]);
    }
  });

  it('keeps custom code inside a sandboxed frame', () => {
    const parsed = new DOMParser().parseFromString(
      renderBlocks(
        [createBlock('customHtml', { html: '<script>x()</script>"', css: '</style><b>' })],
        { ...context, editing: true },
      ),
      'text/html',
    );
    const frame = parsed.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(parsed.querySelectorAll('script')).toHaveLength(0);
    expect(frame.getAttribute('srcdoc')).toContain('<script>x()</script>');
  });

  it('allows only safe links', () => {
    expect(safeUrl('javascript:alert(1)', context)).toBe('');
    expect(safeUrl(' JavaScript:alert(1)', context)).toBe('');
    expect(safeUrl('data:text/html,x', context)).toBe('');
    expect(safeUrl('//evil.example', context)).toBe('');
    expect(safeUrl('example.com/a', context)).toBe('https://example.com/a');
    expect(safeUrl('page:about', context)).toBe('about.html');
    expect(safeUrl('mailto:a@b.co', context)).toBe('mailto:a@b.co');
  });

  it('embeds only YouTube and Vimeo', () => {
    expect(embedUrl('https://youtu.be/abc12345678')).toContain(
      'youtube-nocookie.com/embed/abc12345678',
    );
    expect(embedUrl('https://vimeo.com/12345')).toBe('https://player.vimeo.com/video/12345');
    expect(embedUrl('https://evil.example/embed/x')).toBe('');
  });

  it('writes style overrides', () => {
    expect(styleCss({ paddingY: 10, align: 'center', opacity: 1 }, context)).toBe(
      'padding-top:10px;padding-bottom:10px;text-align:center',
    );
    expect(siteCss({ ...theme, fontFamily: 'a}</style>' })).not.toContain('</style>');
  });
});

describe('website structure', () => {
  const columns = createBlock('columns');
  const a = createBlock('heading');
  const b = createBlock('button');

  it('inserts, finds, moves, duplicates and removes nested blocks', () => {
    let blocks = insertAfter([columns], null, a);
    blocks = insertIntoColumn(blocks, columns.id, 1, b);
    expect(findBlock(blocks, b.id)?.kind).toBe('button');
    blocks = duplicateBlock(blocks, b.id);
    const nested = findBlock(blocks, columns.id)!.columns![1]!;
    expect(nested).toHaveLength(2);
    expect(nested[0]!.id).not.toBe(nested[1]!.id);
    expect(shiftBlock(blocks, a.id, -1)[0]!.id).toBe(a.id);
    expect(shiftBlock(blocks, b.id, -1)).toBe(blocks);
    expect(findBlock(removeBlock(blocks, b.id), b.id)).toBeNull();
  });

  it('keeps blocks when columns are removed', () => {
    const filled = { ...columns, columns: [[a], [b]] };
    expect(setColumnCount(filled, 1).columns![0]!.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(setColumnCount(filled, 3).columns).toHaveLength(3);
  });

  it('makes unique page addresses', () => {
    expect(uniqueSlug('About Us!', [])).toBe('about-us');
    expect(uniqueSlug('About Us', ['about-us'])).toBe('about-us-2');
    expect(uniqueSlug('Index', [])).toBe('index-2');
    expect(uniqueSlug('नमस्ते', [])).toBe('page');
  });

  it('exports a static site with working page links and local assets', () => {
    const pages: PageData[] = [
      {
        title: 'Home',
        slug: 'home',
        seoDescription: '',
        blocks: [
          createBlock('button', { url: 'page:about' }),
          createBlock('image', { media: 'pic' }),
          createBlock('countdown'),
        ],
      },
      {
        title: 'About',
        slug: 'about',
        seoDescription: 'x"y',
        blocks: [createBlock('button', { url: 'page:home' })],
      },
    ];
    expect([...collectMedia(pages)]).toEqual(['pic']);
    const files = buildSite(theme, pages, new Map([['pic', 'photo.png']]));
    expect([...files.keys()]).toEqual(['index.html', 'about.html', 'style.css', 'countdown.js']);
    expect(files.get('index.html')).toContain('href="about.html"');
    expect(files.get('index.html')).toContain('assets/photo.png');
    expect(files.get('index.html')).toContain('countdown.js');
    expect(files.get('about.html')).toContain('href="index.html"');
    expect(files.get('about.html')).not.toContain('data-block-id');
  });

  it('builds every template', () => {
    for (const template of TEMPLATES)
      expect(() => renderBlocks(template.blocks('N'), context)).not.toThrow();
  });
});
