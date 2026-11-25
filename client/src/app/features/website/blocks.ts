/** Every website block: its settings and the HTML it produces. All user text is escaped here. */
import { clamp, escapeHtml as e, uid } from '../../core/util';
import { cleanHtml } from '../../shared/rich-text';
import type { BlockDef, BlockStyle, Field, Props, RenderContext, SiteBlock } from './types';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const list = (value: unknown): Props[] => (Array.isArray(value) ? (value as Props[]) : []);
const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
/** A media value is either a library id or an https address. Quotes and brackets are encoded for CSS. */
export const isWebAddress = (value: string): boolean => /^https:\/\/[^\s]+$/i.test(value);
const source = (value: string, context: RenderContext): string =>
  isWebAddress(value)
    ? value.replace(/["'()\\<>]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
    : context.mediaSrc(value);

/** Only Google's own embed address may replace the generated map. */
export const mapSource = (embed: unknown, address: unknown, zoom: number): string => {
  const url = str(embed).trim();
  return /^https:\/\/www\.google\.com\/maps\/embed\?[\w!.%&=+-]+$/.test(url)
    ? url
    : `https://maps.google.com/maps?q=${encodeURIComponent(str(address))}&z=${zoom}&output=embed`;
};

const PLATFORMS: Record<string, string> = {
  website: '🌐',
  instagram: '📷',
  facebook: 'f',
  x: '𝕏',
  linkedin: 'in',
  youtube: '▶',
  tiktok: '♪',
  whatsapp: '✆',
};

/** Escaped text with line breaks kept. */
const lines = (value: unknown) => e(str(value)).replace(/\n/g, '<br>');

export const safeColor = (value: unknown): string => {
  const text = str(value).trim();
  return /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\))$/i.test(text) ? text : '';
};

/** Allows web, mail, phone, in-page and site-page links; anything else (such as javascript:) is dropped. */
export function safeUrl(value: unknown, context: RenderContext): string {
  const url = str(value).trim();
  if (!url) return '';
  if (url.startsWith('page:')) return context.pageHref(url.slice(5));
  if (/^(https?:|mailto:|tel:)/i.test(url) || url.startsWith('#')) return url;
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') ? '' : `https://${url}`;
}

const link = (url: unknown, text: string, context: RenderContext, className = '') => {
  const href = safeUrl(url, context);
  return href
    ? `<a class="${className}" href="${e(href)}">${text}</a>`
    : `<span class="${className}">${text}</span>`;
};

const image = (id: unknown, alt: unknown, context: RenderContext, className = '') =>
  str(id)
    ? `<img class="${className}" src="${e(source(str(id), context))}" alt="${e(str(alt))}">`
    : '';

const placeholder = (context: RenderContext, text: string) =>
  context.editing ? `<div class="placeholder">${e(text)}</div>` : '';

const field = {
  text: (key: string, label: string): Field => ({ key, label, type: 'text' }),
  area: (key: string, label: string): Field => ({ key, label, type: 'textarea' }),
  link: (key: string, label: string): Field => ({ key, label, type: 'link' }),
  color: (key: string, label: string): Field => ({ key, label, type: 'color' }),
  check: (key: string, label: string): Field => ({ key, label, type: 'checkbox' }),
  image: (key: string, label: string): Field => ({ key, label, type: 'media', kind: 'image' }),
  num: (key: string, label: string, min: number, max: number, unit = ''): Field => ({
    key,
    label,
    type: 'number',
    min,
    max,
    unit,
  }),
  select: (key: string, label: string, options: string[]): Field => ({
    key,
    label,
    type: 'select',
    options: options.map((o) => [o, o]),
  }),
  list: (
    key: string,
    label: string,
    itemLabel: string,
    fields: Field[],
    blank: () => Props,
  ): Field => ({
    key,
    label,
    type: 'list',
    itemLabel,
    fields,
    blank,
  }),
};

const navFields = [field.text('label', 'Label'), field.link('url', 'Link')];
const socialFields = [
  field.select('platform', 'Icon', Object.keys(PLATFORMS)),
  field.text('label', 'Name'),
  field.link('url', 'Profile link'),
];
const social = (items: unknown, context: RenderContext) =>
  `<div class="social">${list(items)
    .map((s) =>
      link(
        s['url'],
        `<span class="social-icon" aria-hidden="true">${PLATFORMS[str(s['platform'])] ?? PLATFORMS['website']}</span> ${e(str(s['label']))}`,
        context,
        'chip',
      ),
    )
    .join('')}</div>`;

/** Only embeds maps and videos from hosts that are meant to be framed. */
export function embedUrl(raw: unknown): string {
  const url = str(raw).trim();
  const youtube =
    /^https:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,20})/.exec(
      url,
    );
  if (youtube) return `https://www.youtube-nocookie.com/embed/${youtube[1]}`;
  const vimeo = /^https:\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/)?(\d+)/.exec(url);
  return vimeo ? `https://player.vimeo.com/video/${vimeo[1]}` : '';
}

export const BLOCKS: BlockDef[] = [
  {
    kind: 'header',
    label: 'Header / menu',
    icon: '▤',
    group: 'Layout',
    defaults: () => ({
      logoText: 'My Brand',
      logo: '',
      sticky: false,
      items: [{ label: 'Home', url: 'page:' }],
    }),
    fields: [
      field.text('logoText', 'Brand name'),
      field.image('logo', 'Logo image'),
      field.check('sticky', 'Stick to top'),
      field.list('items', 'Menu links', 'Link', navFields, () => ({ label: 'Link', url: '' })),
    ],
    render: (b, c) =>
      `<header class="nav${b.props['sticky'] ? ' sticky' : ''}"><div class="brand">${image(b.props['logo'], b.props['logoText'], c, 'logo') || e(str(b.props['logoText']))}</div>` +
      `<nav>${list(b.props['items'])
        .map((i) => link(i['url'], e(str(i['label'])), c))
        .join('')}</nav></header>`,
  },
  {
    kind: 'hero',
    label: 'Hero banner',
    icon: '🏞',
    group: 'Layout',
    defaults: () => ({
      heading: 'Build something great',
      subheading: 'Tell visitors what you do in one clear sentence.',
      buttonLabel: 'Get started',
      buttonUrl: '#',
      background: '',
      minHeight: 360,
    }),
    fields: [
      field.text('heading', 'Heading'),
      field.area('subheading', 'Subheading'),
      field.text('buttonLabel', 'Button text'),
      field.link('buttonUrl', 'Button link'),
      field.image('background', 'Background picture'),
      field.num('minHeight', 'Height', 120, 900, 'px'),
    ],
    render: (b, c) => {
      const bg = str(b.props['background']);
      const style =
        `min-height:${num(b.props['minHeight'], 360)}px;` +
        (bg
          ? `background-image:linear-gradient(rgb(0 0 0/45%),rgb(0 0 0/45%)),url('${e(source(bg, c))}');color:#fff;`
          : '');
      return (
        `<section class="hero" style="${style}"><h1>${lines(b.props['heading'])}</h1><p>${lines(b.props['subheading'])}</p>` +
        `${str(b.props['buttonLabel']) ? link(b.props['buttonUrl'], e(str(b.props['buttonLabel'])), c, 'button solid') : ''}</section>`
      );
    },
  },
  {
    kind: 'columns',
    label: 'Columns',
    icon: '▥',
    group: 'Layout',
    defaults: () => ({ gap: 24, ratio: 'equal' }),
    fields: [
      field.num('gap', 'Gap', 0, 100, 'px'),
      field.select('ratio', 'Widths', ['equal', 'wide-left', 'wide-right']),
    ],
    render: (b, c, children) => {
      const colours = ids(b.props['columnColors']);
      const column = (blocks: SiteBlock[], i: number) => {
        const background = safeColor(
          (b.props['columnColors'] as unknown[] | undefined)?.[i] ?? colours[i],
        );
        const tag = c.editing ? ` data-column="${e(b.id)}|${i}"` : '';
        return `<div class="column"${tag}${background ? ` style="background:${background};padding:12px;border-radius:8px"` : ''}>${children(blocks)}</div>`;
      };
      const columns = b.columns ?? [];
      const widths = columns.map((_, i) =>
        (b.props['ratio'] === 'wide-left' && i === 0) ||
        (b.props['ratio'] === 'wide-right' && i === columns.length - 1)
          ? '2fr'
          : '1fr',
      );
      return `<div class="columns" style="gap:${num(b.props['gap'], 24)}px;--columns:${widths.join(' ')}">${columns.map(column).join('')}</div>`;
    },
  },
  {
    kind: 'spacer',
    label: 'Spacer',
    icon: '↕',
    group: 'Layout',
    defaults: () => ({ height: 48 }),
    fields: [field.num('height', 'Height', 4, 400, 'px')],
    render: (b) => `<div style="height:${num(b.props['height'], 48)}px"></div>`,
  },
  {
    kind: 'divider',
    label: 'Divider',
    icon: '―',
    group: 'Layout',
    defaults: () => ({ thickness: 1, line: 'solid', lineColor: '#cbd5e1' }),
    fields: [
      field.num('thickness', 'Thickness', 1, 20, 'px'),
      field.select('line', 'Line', ['solid', 'dashed', 'dotted']),
      field.color('lineColor', 'Colour'),
    ],
    render: (b) => {
      const line = ['dashed', 'dotted'].includes(str(b.props['line']))
        ? str(b.props['line'])
        : 'solid';
      return `<hr style="border:0;border-top:${num(b.props['thickness'], 1)}px ${line} ${safeColor(b.props['lineColor']) || '#cbd5e1'}">`;
    },
  },
  {
    kind: 'footer',
    label: 'Footer',
    icon: '▁',
    group: 'Layout',
    defaults: () => ({ text: '© My Brand. All rights reserved.', items: [], socials: [] }),
    fields: [
      field.area('text', 'Footer text'),
      field.list('items', 'Links', 'Link', navFields, () => ({ label: 'Link', url: '' })),
      field.list('socials', 'Social links', 'Profile', socialFields, () => ({
        label: 'Instagram',
        url: '',
      })),
    ],
    render: (b, c) =>
      `<footer class="foot"><nav>${list(b.props['items'])
        .map((i) => link(i['url'], e(str(i['label'])), c))
        .join('')}</nav>${social(b.props['socials'], c)}<p>${lines(b.props['text'])}</p></footer>`,
  },
  {
    kind: 'heading',
    label: 'Heading',
    icon: 'H',
    group: 'Text',
    defaults: () => ({ text: 'Section heading', level: '2' }),
    fields: [field.text('text', 'Text'), field.select('level', 'Size level', ['1', '2', '3', '4'])],
    render: (b) => {
      const level = clamp(Math.round(Number(b.props['level']) || 2), 1, 4);
      return `<h${level}>${lines(b.props['text'])}</h${level}>`;
    },
  },
  {
    kind: 'richText',
    label: 'Text',
    icon: '¶',
    group: 'Text',
    defaults: () => ({ html: '<p>Write your content here.</p>' }),
    fields: [{ key: 'html', label: 'Content', type: 'rich' }],
    render: (b) => `<div class="rich">${cleanHtml(str(b.props['html']))}</div>`,
  },
  {
    kind: 'faq',
    label: 'FAQ',
    icon: '❓',
    group: 'Text',
    defaults: () => ({
      items: [{ question: 'What do you offer?', answer: 'Describe your offer here.' }],
    }),
    fields: [
      field.list(
        'items',
        'Questions',
        'Question',
        [field.text('question', 'Question'), field.area('answer', 'Answer')],
        () => ({ question: 'New question', answer: '' }),
      ),
    ],
    render: (b) =>
      `<div class="faq">${list(b.props['items'])
        .map(
          (i) =>
            `<details><summary>${e(str(i['question']))}</summary><p>${lines(i['answer'])}</p></details>`,
        )
        .join('')}</div>`,
  },
  {
    kind: 'iconList',
    label: 'Feature list',
    icon: '☰',
    group: 'Text',
    defaults: () => ({
      perRow: 3,
      items: [
        { icon: '⚡', title: 'Fast', text: 'Loads quickly.' },
        { icon: '🔒', title: 'Safe', text: 'Built with care.' },
        { icon: '💬', title: 'Helpful', text: 'We answer quickly.' },
      ],
    }),
    fields: [
      field.num('perRow', 'Per row', 1, 6),
      field.list(
        'items',
        'Features',
        'Feature',
        [
          field.text('icon', 'Emoji'),
          field.text('title', 'Title'),
          field.area('text', 'Description'),
        ],
        () => ({ icon: '✅', title: 'Feature', text: '' }),
      ),
    ],
    render: (b) =>
      `<div class="grid" style="--per:${num(b.props['perRow'], 3)}">${list(b.props['items'])
        .map(
          (i) =>
            `<div class="card"><div class="big">${e(str(i['icon']))}</div><h3>${e(str(i['title']))}</h3><p>${lines(i['text'])}</p></div>`,
        )
        .join('')}</div>`,
  },
  {
    kind: 'icon',
    label: 'Icon',
    icon: '★',
    group: 'Text',
    defaults: () => ({ symbol: '★', size: 64 }),
    fields: [field.text('symbol', 'Emoji or symbol'), field.num('size', 'Size', 12, 240, 'px')],
    render: (b) =>
      `<div style="font-size:${num(b.props['size'], 64)}px;line-height:1.2">${e(str(b.props['symbol']))}</div>`,
  },
  {
    kind: 'image',
    label: 'Image',
    icon: '🖼',
    group: 'Media',
    defaults: () => ({ media: '', alt: '', url: '', width: 100 }),
    fields: [
      field.image('media', 'Picture'),
      field.text('alt', 'Description (for accessibility)'),
      field.link('url', 'Link when clicked'),
      field.num('width', 'Width', 10, 100, '%'),
    ],
    render: (b, c) => {
      if (!str(b.props['media'])) return placeholder(c, 'Choose a picture');
      const picture = `<img src="${e(source(str(b.props['media']), c))}" alt="${e(str(b.props['alt']))}" style="width:${num(b.props['width'], 100)}%">`;
      return str(b.props['url']) ? link(b.props['url'], picture, c) : picture;
    },
  },
  {
    kind: 'gallery',
    label: 'Gallery',
    icon: '▦',
    group: 'Media',
    defaults: () => ({ media: [], layout: 'grid', perRow: 3 }),
    fields: [
      { key: 'media', label: 'Pictures', type: 'gallery' },
      field.select('layout', 'Layout', ['grid', 'carousel']),
      field.num('perRow', 'Per row', 1, 6),
    ],
    render: (b, c) => {
      const media = ids(b.props['media']);
      if (!media.length) return placeholder(c, 'Add pictures to the gallery');
      const kind = b.props['layout'] === 'carousel' ? 'carousel' : 'grid gallery';
      return `<div class="${kind}" style="--per:${num(b.props['perRow'], 3)}">${media.map((id) => image(id, '', c)).join('')}</div>`;
    },
  },
  {
    kind: 'video',
    label: 'Video',
    icon: '▶',
    group: 'Media',
    defaults: () => ({ media: '', embed: '', controls: true, autoplay: false, loop: false }),
    fields: [
      { key: 'media', label: 'Video from library', type: 'media', kind: 'video' },
      field.text('embed', 'Or a YouTube / Vimeo link'),
      field.check('controls', 'Show player controls'),
      field.check('autoplay', 'Autoplay (muted)'),
      field.check('loop', 'Loop'),
    ],
    render: (b, c) => {
      const embed = embedUrl(b.props['embed']);
      // Players need scripts, which the editor frame deliberately does not run.
      if (embed && c.editing)
        return placeholder(c, 'Embedded video: it plays in the exported website');
      if (embed)
        return `<div class="ratio"><iframe src="${e(embed)}" title="Video" allowfullscreen sandbox="allow-scripts allow-same-origin allow-presentation"></iframe></div>`;
      if (!str(b.props['media'])) return placeholder(c, 'Choose a video or paste a link');
      return `<video src="${e(source(str(b.props['media']), c))}"${b.props['controls'] === false ? '' : ' controls'}${b.props['autoplay'] ? ' autoplay muted' : ''}${b.props['loop'] ? ' loop' : ''} playsinline></video>`;
    },
  },
  {
    kind: 'map',
    label: 'Map',
    icon: '📍',
    group: 'Media',
    defaults: () => ({ address: 'Hyderabad, India', embed: '', zoom: 13, height: 320 }),
    fields: [
      field.text('address', 'Address or place'),
      field.text('embed', 'Or a Google Maps embed address'),
      field.num('zoom', 'Zoom', 1, 20),
      field.num('height', 'Height', 150, 700, 'px'),
    ],
    render: (b, c) =>
      c.editing
        ? placeholder(c, `Map of ${str(b.props['address'])}: shown in the exported website`)
        : `<iframe class="map" title="Map" style="height:${num(b.props['height'], 320)}px" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups" src="${e(mapSource(b.props['embed'], b.props['address'], num(b.props['zoom'], 13)))}"></iframe>`,
  },
  {
    kind: 'button',
    label: 'Button',
    icon: '⬭',
    group: 'Marketing',
    defaults: () => ({ label: 'Click me', url: '#', variant: 'solid' }),
    fields: [
      field.text('label', 'Text'),
      field.link('url', 'Link'),
      field.select('variant', 'Style', ['solid', 'outline', 'ghost']),
    ],
    render: (b, c) =>
      link(
        b.props['url'],
        e(str(b.props['label'])),
        c,
        `button ${['outline', 'ghost'].includes(str(b.props['variant'])) ? str(b.props['variant']) : 'solid'}`,
      ),
  },
  {
    kind: 'testimonial',
    label: 'Testimonial',
    icon: '❝',
    group: 'Marketing',
    defaults: () => ({
      quote: 'This changed how we work.',
      author: 'A happy customer',
      role: '',
      avatar: '',
      rating: 5,
    }),
    fields: [
      field.area('quote', 'Quote'),
      field.text('author', 'Name'),
      field.text('role', 'Role'),
      field.image('avatar', 'Photo'),
      field.num('rating', 'Stars', 0, 5),
    ],
    render: (b, c) =>
      `<figure class="testimonial"><div class="stars">${'★'.repeat(clamp(Math.round(num(b.props['rating'], 5)), 0, 5))}</div><blockquote>${lines(b.props['quote'])}</blockquote><figcaption>${image(b.props['avatar'], b.props['author'], c, 'avatar')}<strong>${e(str(b.props['author']))}</strong> <span>${e(str(b.props['role']))}</span></figcaption></figure>`,
  },
  {
    kind: 'pricing',
    label: 'Pricing table',
    icon: '💲',
    group: 'Marketing',
    defaults: () => ({
      plans: [
        {
          name: 'Basic',
          price: '₹499',
          period: '/month',
          features: 'One user\nEmail support',
          cta: 'Choose',
          url: '#',
          highlight: false,
        },
        {
          name: 'Pro',
          price: '₹999',
          period: '/month',
          features: 'Five users\nPriority support',
          cta: 'Choose',
          url: '#',
          highlight: true,
        },
      ],
    }),
    fields: [
      field.list(
        'plans',
        'Plans',
        'Plan',
        [
          field.text('name', 'Name'),
          field.text('price', 'Price'),
          field.text('period', 'Period'),
          field.area('features', 'Features, one per line'),
          field.text('cta', 'Button text'),
          field.link('url', 'Button link'),
          field.check('highlight', 'Highlight'),
        ],
        () => ({
          name: 'Plan',
          price: '',
          period: '',
          features: '',
          cta: 'Choose',
          url: '#',
          highlight: false,
        }),
      ),
    ],
    render: (b, c) =>
      `<div class="grid pricing" style="--per:${Math.max(1, Math.min(4, list(b.props['plans']).length))}">${list(
        b.props['plans'],
      )
        .map(
          (p) =>
            `<div class="card plan${p['highlight'] ? ' highlight' : ''}"><h3>${e(str(p['name']))}</h3><div class="big">${e(str(p['price']))}<small>${e(str(p['period']))}</small></div><ul>${str(
              p['features'],
            )
              .split('\n')
              .filter(Boolean)
              .map((f) => `<li>${e(f)}</li>`)
              .join('')}</ul>${link(p['url'], e(str(p['cta'])), c, 'button solid')}</div>`,
        )
        .join('')}</div>`,
  },
  {
    kind: 'team',
    label: 'Team',
    icon: '👥',
    group: 'Marketing',
    defaults: () => ({
      perRow: 3,
      members: [{ name: 'Team member', role: 'Role', photo: '', bio: '' }],
    }),
    fields: [
      field.num('perRow', 'Per row', 1, 6),
      field.list(
        'members',
        'People',
        'Person',
        [
          field.text('name', 'Name'),
          field.text('role', 'Role'),
          field.image('photo', 'Photo'),
          field.area('bio', 'About'),
        ],
        () => ({ name: 'Name', role: '', photo: '', bio: '' }),
      ),
    ],
    render: (b, c) =>
      `<div class="grid" style="--per:${num(b.props['perRow'], 3)}">${list(b.props['members'])
        .map(
          (m) =>
            `<div class="card person">${image(m['photo'], m['name'], c, 'avatar large')}<h3>${e(str(m['name']))}</h3><p><em>${e(str(m['role']))}</em></p><p>${lines(m['bio'])}</p></div>`,
        )
        .join('')}</div>`,
  },
  {
    kind: 'stats',
    label: 'Numbers',
    icon: '№',
    group: 'Marketing',
    defaults: () => ({
      items: [
        { value: '10+', label: 'Years' },
        { value: '500', label: 'Projects' },
        { value: '99%', label: 'Happy clients' },
      ],
    }),
    fields: [
      field.list(
        'items',
        'Numbers',
        'Number',
        [field.text('value', 'Value'), field.text('label', 'Label')],
        () => ({ value: '0', label: '' }),
      ),
    ],
    render: (b) =>
      `<div class="stats">${list(b.props['items'])
        .map(
          (i) =>
            `<div><div class="big">${e(str(i['value']))}</div><span>${e(str(i['label']))}</span></div>`,
        )
        .join('')}</div>`,
  },
  {
    kind: 'social',
    label: 'Social links',
    icon: '🔗',
    group: 'Marketing',
    defaults: () => ({
      items: [
        { platform: 'instagram', label: 'Instagram', url: 'https://instagram.com' },
        { platform: 'linkedin', label: 'LinkedIn', url: 'https://linkedin.com' },
      ],
    }),
    fields: [
      field.list('items', 'Profiles', 'Profile', socialFields, () => ({
        label: 'Website',
        url: '',
      })),
    ],
    render: (b, c) => social(b.props['items'], c),
  },
  {
    kind: 'form',
    label: 'Contact form',
    icon: '✉',
    group: 'Interactive',
    defaults: () => ({
      email: '',
      submitLabel: 'Send message',
      fields: [
        { label: 'Name', type: 'text', required: true },
        { label: 'Email', type: 'email', required: true },
        { label: 'Message', type: 'textarea', required: false },
      ],
    }),
    fields: [
      field.text('email', 'Send to email address'),
      field.text('submitLabel', 'Button text'),
      field.list(
        'fields',
        'Form fields',
        'Field',
        [
          field.text('label', 'Label'),
          field.select('type', 'Type', ['text', 'email', 'tel', 'textarea']),
          field.check('required', 'Required'),
        ],
        () => ({ label: 'Field', type: 'text', required: false }),
      ),
    ],
    render: (b) => {
      const email = /^[^\s@<>"?&]+@[^\s@<>"?&]+\.[^\s@<>"?&]+$/.test(str(b.props['email']))
        ? str(b.props['email'])
        : '';
      const inputs = list(b.props['fields']).map((f) => {
        const required = f['required'] ? ' required' : '';
        const type = ['email', 'tel'].includes(str(f['type'])) ? str(f['type']) : 'text';
        const name = e(str(f['label']));
        return `<label>${name}${f['type'] === 'textarea' ? `<textarea name="${name}" rows="4"${required}></textarea>` : `<input name="${name}" type="${type}"${required}>`}</label>`;
      });
      // Static sites have no server, so submissions open the visitor's mail app.
      return `<form class="contact" ${email ? `action="mailto:${e(email)}" method="post" enctype="text/plain"` : ''}>${inputs.join('')}<button class="button solid" type="${email ? 'submit' : 'button'}">${e(str(b.props['submitLabel']))}</button></form>`;
    },
  },
  {
    kind: 'countdown',
    label: 'Countdown',
    icon: '⏳',
    group: 'Interactive',
    defaults: () => ({
      target: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 16),
      title: 'Launching in',
    }),
    fields: [
      field.text('title', 'Title'),
      { key: 'target', label: 'Counts down to', type: 'datetime' },
    ],
    render: (b) => {
      const left = Math.max(0, new Date(str(b.props['target'])).getTime() - Date.now()) || 0;
      const days = Math.floor(left / 86_400_000);
      const clock = [
        Math.floor(left / 3_600_000) % 24,
        Math.floor(left / 60_000) % 60,
        Math.floor(left / 1000) % 60,
      ]
        .map((n) => String(n).padStart(2, '0'))
        .join(':');
      return `<div class="countdown"><p>${e(str(b.props['title']))}</p><div class="big" data-countdown="${e(str(b.props['target']))}">${days}d ${clock}</div></div>`;
    },
  },
  {
    kind: 'tabs',
    label: 'Tabs',
    icon: '🗂',
    group: 'Interactive',
    defaults: () => ({
      items: [
        { key: uid(), label: 'First', text: 'First tab content.' },
        { key: uid(), label: 'Second', text: 'Second tab content.' },
      ],
    }),
    fields: [
      field.list(
        'items',
        'Tabs',
        'Tab',
        [field.text('label', 'Label'), field.area('text', 'Content')],
        () => ({ key: uid(), label: 'Tab', text: '' }),
      ),
    ],
    // Radio buttons make the tabs work without any JavaScript.
    render: (b, c, children) =>
      `<div class="tabs">${list(b.props['items'])
        .map((t, i) => {
          const nested = b.columns?.[i] ?? [];
          const tag = c.editing ? ` data-column="${e(b.id)}|${i}"` : '';
          const inner = nested.length ? children(nested) : '';
          return `<input type="radio" name="tabs-${e(b.id)}" id="tab-${e(b.id)}-${i}"${i === 0 ? ' checked' : ''}><label for="tab-${e(b.id)}-${i}">${e(str(t['label']))}</label><div class="tab-panel"${tag}><p>${lines(t['text'])}</p>${inner}</div>`;
        })
        .join('')}</div>`,
  },
  {
    kind: 'customHtml',
    label: 'Custom HTML / CSS',
    icon: '</>',
    group: 'Interactive',
    defaults: () => ({
      html: '<div class="box">Your own design</div>',
      css: '.box { padding: 24px; border: 2px dashed #6366f1; text-align: center; font-family: sans-serif; }',
      height: 160,
    }),
    fields: [
      { key: 'html', label: 'HTML', type: 'code' },
      { key: 'css', label: 'CSS', type: 'code' },
      field.num('height', 'Height', 40, 2000, 'px'),
    ],
    // Isolated in its own frame, so custom code cannot restyle or script the rest of the page.
    render: (b, c) =>
      `<iframe class="custom" title="Custom content" style="height:${num(b.props['height'], 160)}px" sandbox="${c.editing ? '' : 'allow-scripts allow-forms allow-popups'}" srcdoc="${e(`<!doctype html><style>body{margin:0}${str(b.props['css']).replace(/<\/style/gi, '<\\/style')}</style>${str(b.props['html'])}`)}"></iframe>`,
  },
];

export const blockDef = (kind: string): BlockDef | undefined => BLOCKS.find((b) => b.kind === kind);

export function createBlock(kind: string, props: Props = {}, style: BlockStyle = {}): SiteBlock {
  const def = blockDef(kind);
  if (!def) throw new Error(`Unknown block type ${kind}`);
  const block = {
    id: uid(),
    kind,
    props: { ...def.defaults(), ...props },
    style: { ...style },
    ...(kind === 'columns' ? { columns: [[], []] } : {}),
  } as SiteBlock;
  if (kind === 'tabs') block.columns = (block.props['items'] as unknown[]).map(() => []);
  return block;
}

export function styleCss(style: BlockStyle, context: RenderContext): string {
  const css: string[] = [];
  const px = (name: string, value: number | undefined) => {
    if (typeof value === 'number' && Number.isFinite(value)) css.push(`${name}:${value}px`);
  };
  if (style.paddingY !== undefined) {
    px('padding-top', style.paddingY);
    px('padding-bottom', style.paddingY);
  }
  if (style.paddingX !== undefined) {
    px('padding-left', style.paddingX);
    px('padding-right', style.paddingX);
  }
  if (style.marginY !== undefined) {
    px('margin-top', style.marginY);
    px('margin-bottom', style.marginY);
  }
  if (safeColor(style.background)) css.push(`background-color:${safeColor(style.background)}`);
  if (style.backgroundImage)
    css.push(
      `background-image:url('${source(style.backgroundImage, context)}')`,
      'background-size:cover',
      'background-position:center',
    );
  if (safeColor(style.color)) css.push(`color:${safeColor(style.color)}`);
  px('padding-top', style.paddingTop);
  px('padding-right', style.paddingRight);
  px('padding-bottom', style.paddingBottom);
  px('padding-left', style.paddingLeft);
  px('margin-top', style.marginTop);
  px('margin-bottom', style.marginBottom);
  px('font-size', style.fontSize);
  if (style.fontWeight) css.push(`font-weight:${Number(style.fontWeight)}`);
  if (style.align && ['left', 'center', 'right'].includes(style.align))
    css.push(`text-align:${style.align}`);
  px('border-radius', style.radius);
  if (style.borderWidth)
    css.push(
      `border:${Number(style.borderWidth)}px solid ${safeColor(style.borderColor) || '#cbd5e1'}`,
    );
  if (style.maxWidth)
    css.push(`max-width:${Number(style.maxWidth)}px`, 'margin-left:auto', 'margin-right:auto');
  if (style.opacity !== undefined && style.opacity < 1)
    css.push(`opacity:${Number(style.opacity)}`);
  return css.join(';');
}

export function renderBlocks(blocks: SiteBlock[], context: RenderContext): string {
  return blocks
    .map((block) => {
      const def = blockDef(block.kind);
      if (!def) return '';
      const inner = def.render(
        block,
        context,
        (children) =>
          renderBlocks(children, context) ||
          (context.editing ? '<div class="placeholder">Empty column</div>' : ''),
      );
      const attributes = context.editing ? ` data-block-id="${e(block.id)}" draggable="true"` : '';
      return `<div class="block block-${e(block.kind)}${block.style.hideOnMobile ? ' hide-mobile' : ''}"${attributes} style="${e(styleCss(block.style, context))}">${inner}</div>`;
    })
    .join('\n');
}
