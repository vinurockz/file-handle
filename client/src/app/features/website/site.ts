/** Block-tree operations, page documents, templates and static export. */
import { escapeHtml, moveItem, uid } from '../../core/util';
import { createBlock, renderBlocks, safeColor } from './blocks';
import type { RenderContext, SiteBlock, SiteTheme } from './types';

type Edit = (list: SiteBlock[], index: number) => SiteBlock[];

/** Applies `edit` to whichever list holds `id`, searching inside columns too. */
function editAt(blocks: SiteBlock[], id: string, edit: Edit): SiteBlock[] {
  const index = blocks.findIndex((b) => b.id === id);
  if (index >= 0) return edit(blocks, index);
  let changed = false;
  const next = blocks.map((block) => {
    if (!block.columns) return block;
    const columns = block.columns.map((column) => {
      const result = editAt(column, id, edit);
      if (result !== column) changed = true;
      return result;
    });
    return columns.some((c, i) => c !== block.columns![i]) ? { ...block, columns } : block;
  });
  return changed ? next : blocks;
}

export function findBlock(blocks: SiteBlock[], id: string | null): SiteBlock | null {
  for (const block of blocks) {
    if (block.id === id) return block;
    for (const column of block.columns ?? []) {
      const found = findBlock(column, id);
      if (found) return found;
    }
  }
  return null;
}

export const updateBlock = (blocks: SiteBlock[], id: string, change: (b: SiteBlock) => SiteBlock) =>
  editAt(blocks, id, (list, i) => list.map((b, j) => (j === i ? change(b) : b)));

export const removeBlock = (blocks: SiteBlock[], id: string) =>
  editAt(blocks, id, (list, i) => list.filter((_, j) => j !== i));

export const shiftBlock = (blocks: SiteBlock[], id: string, by: number) =>
  editAt(blocks, id, (list, i) =>
    i + by < 0 || i + by >= list.length ? list : moveItem(list, i, i + by),
  );

export const insertAfter = (blocks: SiteBlock[], id: string | null, added: SiteBlock) => {
  if (!id || !findBlock(blocks, id)) return [...blocks, added];
  return editAt(blocks, id, (list, i) => [...list.slice(0, i + 1), added, ...list.slice(i + 1)]);
};

export const insertIntoColumn = (
  blocks: SiteBlock[],
  parentId: string,
  column: number,
  added: SiteBlock,
) =>
  updateBlock(blocks, parentId, (b) => ({
    ...b,
    columns: (b.columns ?? []).map((c, i) => (i === column ? [...c, added] : c)),
  }));

export const cloneBlock = (block: SiteBlock): SiteBlock => ({
  ...structuredClone(block),
  id: uid(),
  ...(block.columns ? { columns: block.columns.map((c) => c.map(cloneBlock)) } : {}),
});

export const duplicateBlock = (blocks: SiteBlock[], id: string) =>
  editAt(blocks, id, (list, i) => [
    ...list.slice(0, i + 1),
    cloneBlock(list[i]!),
    ...list.slice(i + 1),
  ]);

/** Adds or removes columns; blocks from a removed column move into the last remaining one. */
export function setColumnCount(block: SiteBlock, count: number): SiteBlock {
  const columns = [...(block.columns ?? [])];
  while (columns.length < count) columns.push([]);
  const extra = columns.splice(count).flat();
  if (extra.length) columns[count - 1] = [...columns[count - 1]!, ...extra];
  return { ...block, columns };
}

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

export function uniqueSlug(wanted: string, taken: string[]): string {
  const base = slugify(wanted) || 'page';
  let slug = base;
  for (let i = 2; taken.includes(slug) || slug === 'index'; i++) slug = `${base}-${i}`;
  return slug;
}

export function siteCss(theme: SiteTheme): string {
  const accent = safeColor(theme.themeColor) || '#4f46e5';
  const font = theme.fontFamily.replace(/[<>{};]/g, '');
  return `*{box-sizing:border-box}body{margin:0;font-family:${font};color:${safeColor(theme.textColor) || '#0f172a'};background:${safeColor(theme.backgroundColor) || '#fff'};line-height:1.55;overflow-wrap:anywhere}
img,video{max-width:100%;height:auto;vertical-align:middle}a{color:${accent}}.block{padding:12px 24px}.block-header,.block-footer,.block-hero,.block-spacer{padding:0}
h1,h2,h3,h4{line-height:1.2;margin:.4em 0}
.nav{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:16px 24px;border-bottom:1px solid rgb(0 0 0/8%)}
.block-header:has(.sticky){position:sticky;top:0;z-index:10;background:${safeColor(theme.backgroundColor) || '#fff'}}.brand{font-weight:800;font-size:1.25rem}.logo{max-height:44px}
nav{display:flex;gap:18px;flex-wrap:wrap}nav a{text-decoration:none;color:inherit}
.hero{display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:48px 24px;background-size:cover;background-position:center}.hero h1{font-size:clamp(2rem,6vw,3.4rem)}
.button{display:inline-block;padding:11px 22px;border-radius:8px;border:2px solid ${accent};text-decoration:none;font:inherit;font-weight:600;cursor:pointer}.button.solid{background:${accent};color:#fff}.button.outline{color:${accent};background:transparent}.button.ghost{border-color:transparent;color:${accent};background:transparent}
.columns{display:grid;grid-template-columns:var(--columns)}.column{min-width:0}
.grid{display:grid;grid-template-columns:repeat(var(--per),minmax(0,1fr));gap:18px}.gallery img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px}
.carousel{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory}.carousel img{flex:0 0 calc(100%/var(--per) - 12px);min-width:220px;aspect-ratio:4/3;object-fit:cover;border-radius:8px;scroll-snap-align:start}
.card{border:1px solid rgb(0 0 0/10%);border-radius:12px;padding:20px}.big{font-size:2rem;font-weight:800}.big small{font-size:1rem;font-weight:400}
.plan.highlight{border:2px solid ${accent};box-shadow:0 12px 30px rgb(0 0 0/12%)}.plan ul{padding-left:18px;text-align:left}
.avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;margin-right:8px}.avatar.large{width:110px;height:110px}.person{text-align:center}
.testimonial{margin:0;text-align:center}.testimonial blockquote{font-size:1.25rem;margin:8px 0}.stars{color:#f59e0b;font-size:1.3rem}
.stats{display:flex;justify-content:space-around;flex-wrap:wrap;gap:24px;text-align:center}.stats .big{color:${accent}}
.social{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}.social-icon{font-weight:800;margin-right:4px}.chip{border:1px solid ${accent};border-radius:99px;padding:5px 14px;text-decoration:none}
.foot{text-align:center;padding:28px 24px;border-top:1px solid rgb(0 0 0/10%)}.foot nav{justify-content:center;margin-bottom:12px}
.faq details{border-bottom:1px solid rgb(0 0 0/12%);padding:12px 0}.faq summary{font-weight:600;cursor:pointer}
.contact{display:flex;flex-direction:column;gap:12px;max-width:520px;margin:auto;text-align:left}.contact label{display:flex;flex-direction:column;gap:4px}.contact input,.contact textarea{font:inherit;padding:9px;border:1px solid #cbd5e1;border-radius:8px}
.countdown{text-align:center}.countdown .big{font-variant-numeric:tabular-nums}
.tabs{display:flex;flex-wrap:wrap}.tabs input{position:absolute;opacity:0}.tabs label{order:1;padding:9px 18px;cursor:pointer;border-bottom:3px solid transparent}.tabs input:checked+label{border-color:${accent};font-weight:700}.tabs input:focus-visible+label{outline:2px solid ${accent}}.tab-panel{order:2;width:100%;display:none;padding:12px 4px}.tabs input:checked+label+.tab-panel{display:block}
.ratio{position:relative;aspect-ratio:16/9}.ratio iframe{position:absolute;inset:0;width:100%;height:100%;border:0}.map,.custom{width:100%;border:0;display:block}
@media(max-width:720px){.columns{grid-template-columns:1fr}.grid{grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr))}.hide-mobile{display:none}}`;
}

export const EDITOR_CSS = `.drop-before{box-shadow:0 -4px 0 #4f46e5}.drop-after{box-shadow:0 4px 0 #4f46e5}.drop-into{outline:3px dashed #4f46e5!important;min-height:40px}[data-column]{min-height:32px}
[data-block-id]{cursor:pointer;outline:1px dashed transparent;outline-offset:-2px;min-height:8px}[data-block-id]:hover{outline-color:#94a3b8}[data-block-id].is-selected{outline:2px solid #4f46e5}
iframe,video{pointer-events:none}.placeholder{border:2px dashed #94a3b8;border-radius:8px;padding:24px;text-align:center;color:#64748b;font-family:sans-serif}`;

/** Ticks countdown timers in exported sites. */
export const COUNTDOWN_JS = `setInterval(function(){document.querySelectorAll('[data-countdown]').forEach(function(el){var left=Math.max(0,new Date(el.getAttribute('data-countdown')).getTime()-Date.now())||0;var two=function(n){return String(n).padStart(2,'0')};el.textContent=Math.floor(left/864e5)+'d '+two(Math.floor(left/36e5)%24)+':'+two(Math.floor(left/6e4)%60)+':'+two(Math.floor(left/1e3)%60)})},1000);`;

export interface PageData {
  title: string;
  slug: string;
  seoDescription: string;
  blocks: SiteBlock[];
}

export function pageHtml(
  theme: SiteTheme,
  page: PageData,
  context: RenderContext,
  css: { href: string } | { inline: string },
): string {
  const icon = theme.faviconMediaId ? context.mediaSrc(theme.faviconMediaId) : '';
  const countdown = JSON.stringify(page.blocks).includes('"kind":"countdown"');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${page.title} · ${theme.name}`)}</title>
${icon ? `<link rel="icon" href="${escapeHtml(icon)}">\n` : ''}<meta name="description" content="${escapeHtml(page.seoDescription)}">
<meta property="og:title" content="${escapeHtml(page.title)}">
<meta property="og:description" content="${escapeHtml(page.seoDescription)}">
${'href' in css ? `<link rel="stylesheet" href="${css.href}">` : `<style>${css.inline}</style>`}
</head>
<body>
<main>
${renderBlocks(page.blocks, context)}
</main>${countdown && !context.editing ? '\n<script src="countdown.js"></script>' : ''}
</body>
</html>`;
}

/** The first page becomes index.html. */
export const fileFor = (pages: PageData[], index: number): string =>
  index === 0 ? 'index.html' : `${pages[index]!.slug || `page-${index + 1}`}.html`;

export function collectMedia(pages: PageData[]): Set<string> {
  const found = new Set<string>();
  const context: RenderContext = {
    editing: false,
    pageHref: () => '#',
    mediaSrc: (id) => {
      found.add(id);
      return 'asset';
    },
  };
  pages.forEach((p) => renderBlocks(p.blocks, context));
  return found;
}

/** Text files of the finished static site; the caller adds the media under assets/. */
export function buildSite(
  theme: SiteTheme,
  pages: PageData[],
  assets: ReadonlyMap<string, string>,
): Map<string, string> {
  const files = new Map<string, string>();
  const context: RenderContext = {
    editing: false,
    mediaSrc: (id) => (assets.has(id) ? `assets/${assets.get(id)}` : ''),
    pageHref: (slug) => {
      const index = pages.findIndex((p) => p.slug === slug);
      return fileFor(pages, Math.max(0, index));
    },
  };
  pages.forEach((page, i) =>
    files.set(fileFor(pages, i), pageHtml(theme, page, context, { href: 'style.css' })),
  );
  files.set('style.css', siteCss(theme));
  files.set('countdown.js', COUNTDOWN_JS);
  return files;
}

export interface Template {
  name: string;
  description: string;
  themeColor: string;
  blocks(siteName: string): SiteBlock[];
}

const columns = (...lists: SiteBlock[][]): SiteBlock => ({
  ...createBlock('columns'),
  columns: lists,
});

export const TEMPLATES: Template[] = [
  {
    name: 'Blank',
    description: 'Start from an empty page',
    themeColor: '#4f46e5',
    blocks: () => [],
  },
  {
    name: 'Business',
    description: 'Header, hero, features, pricing and contact',
    themeColor: '#2563eb',
    blocks: (n) => [
      createBlock('header', { logoText: n }),
      createBlock('hero', { heading: `Welcome to ${n}` }, { background: '#eff6ff' }),
      createBlock('heading', { text: 'Why choose us' }, { align: 'center' }),
      createBlock('iconList', {}, { align: 'center' }),
      createBlock('pricing', {}, { align: 'center' }),
      createBlock('heading', { text: 'Contact us' }, { align: 'center' }),
      createBlock('form'),
      createBlock('footer', { text: `© ${n}` }),
    ],
  },
  {
    name: 'Portfolio',
    description: 'Show your work with a gallery',
    themeColor: '#db2777',
    blocks: (n) => [
      createBlock('header', { logoText: n }),
      createBlock('hero', { heading: n, subheading: 'Designer and maker', buttonLabel: '' }),
      createBlock('gallery'),
      columns(
        [createBlock('heading', { text: 'About me' }), createBlock('richText')],
        [createBlock('testimonial')],
      ),
      createBlock('social'),
      createBlock('footer', { text: `© ${n}` }),
    ],
  },
  {
    name: 'Event',
    description: 'Countdown, highlights and questions',
    themeColor: '#7c3aed',
    blocks: (n) => [
      createBlock(
        'hero',
        { heading: n, subheading: 'Join us for a day to remember', buttonLabel: 'Register' },
        { background: '#f5f3ff' },
      ),
      createBlock('countdown'),
      createBlock('stats'),
      createBlock('faq', {}, { maxWidth: 720 }),
      createBlock('map'),
      createBlock('footer', { text: `© ${n}` }),
    ],
  },
];
