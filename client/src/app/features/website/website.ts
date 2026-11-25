import { CdkDrag, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { injectCollection, type Doc } from '../../core/collection';
import { handleHistoryKey, History } from '../../core/history';
import { MediaLibrary, mediaFilename, mediaUrl } from '../../core/media';
import { Ui } from '../../core/ui';
import { downloadBlob, isTyping, moveItem, safeFilename, uniqueName } from '../../core/util';
import { Modal } from '../../shared/widgets';
import { blockDef, BLOCKS, createBlock, renderBlocks } from './blocks';
import {
  DRAG_MOVE,
  DRAG_NEW,
  dropTargetAt,
  moveBlock,
  placeBlock,
  syncTabs,
  type DropTarget,
} from './drag';
import { FieldEditor } from './field-editor';
import {
  buildSite,
  cloneBlock,
  collectMedia,
  duplicateBlock,
  EDITOR_CSS,
  findBlock,
  insertAfter,
  insertIntoColumn,
  pageHtml,
  removeBlock,
  setColumnCount,
  shiftBlock,
  siteCss,
  TEMPLATES,
  uniqueSlug,
  updateBlock,
  type PageData,
  type Template,
} from './site';
import type { Field, Props, RenderContext, SiteBlock, SiteTheme } from './types';

type Site = Doc & SiteTheme;
type SitePage = Doc & PageData;
type Device = 'desktop' | 'tablet' | 'mobile';

const SITE_FONTS: [string, string][] = [
  ['system-ui, sans-serif', 'Modern sans'],
  ['Georgia, serif', 'Classic serif'],
  ["'Trebuchet MS', sans-serif", 'Rounded'],
  ["'Courier New', monospace", 'Typewriter'],
  ['Verdana, sans-serif', 'Verdana'],
];

const STYLE_FIELDS: Field[] = [
  {
    key: 'align',
    label: 'Text alignment',
    type: 'select',
    options: [
      ['', 'Default'],
      ['left', 'Left'],
      ['center', 'Centre'],
      ['right', 'Right'],
    ],
  },
  {
    key: 'fontWeight',
    label: 'Weight',
    type: 'select',
    options: [
      ['', 'Default'],
      ['400', 'Normal'],
      ['500', 'Medium'],
      ['600', 'Semi-bold'],
      ['700', 'Bold'],
    ],
  },
  { key: 'hideOnMobile', label: 'Hide on phones', type: 'checkbox' },
];
const STYLE_NUMBERS: { key: string; label: string; min: number; max: number }[] = [
  { key: 'paddingTop', label: 'Padding top', min: 0, max: 300 },
  { key: 'paddingRight', label: 'Padding right', min: 0, max: 300 },
  { key: 'paddingBottom', label: 'Padding bottom', min: 0, max: 300 },
  { key: 'paddingLeft', label: 'Padding left', min: 0, max: 300 },
  { key: 'marginTop', label: 'Margin top', min: 0, max: 300 },
  { key: 'marginBottom', label: 'Margin bottom', min: 0, max: 300 },
  { key: 'fontSize', label: 'Font size', min: 8, max: 96 },
  { key: 'radius', label: 'Corner radius', min: 0, max: 100 },
  { key: 'borderWidth', label: 'Border width', min: 0, max: 20 },
  { key: 'maxWidth', label: 'Maximum width', min: 100, max: 2000 },
];

@Component({
  selector: 'app-website',
  imports: [FieldEditor, Modal, CdkDrag, CdkDropList],
  host: { '(document:keydown)': 'keys($event)' },
  templateUrl: './website.html',
  styleUrl: './website.scss',
})
export class Website implements OnInit {
  protected readonly sites = injectCollection<Site>('sites');
  protected readonly pages = injectCollection<SitePage>('sitePages');
  private readonly library = inject(MediaLibrary);
  private readonly ui = inject(Ui);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');

  protected readonly siteId = signal<string | null>(null);
  protected readonly site = computed(() => this.sites.byId(this.siteId()));
  protected readonly pageId = signal<string | null>(null);
  protected readonly page = computed(() => this.pages.byId(this.pageId()));
  protected readonly history = new History<SiteBlock[]>([]);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly selected = computed(() => findBlock(this.history.value, this.selectedId()));
  protected readonly def = computed(() => blockDef(this.selected()?.kind ?? ''));
  /** When set, new blocks go into this column rather than after the selection. */
  protected readonly target = signal<{ id: string; column: number } | null>(null);
  protected readonly device = signal<Device>('desktop');
  protected readonly creating = signal(false);
  protected readonly previewHtml = signal<string | null>(null);
  protected readonly previewDocument = computed(() => {
    const html = this.previewHtml();
    return html === null ? null : this.trusted(html);
  });
  protected readonly busy = signal(false);
  private readonly frameReady = signal(0);

  protected readonly templates = TEMPLATES;
  protected readonly siteFonts = SITE_FONTS;
  protected readonly styleFields = STYLE_FIELDS;
  protected readonly styleNumbers = STYLE_NUMBERS;
  protected readonly groups = [...new Set(BLOCKS.map((b) => b.group))].map((name) => ({
    name,
    blocks: BLOCKS.filter((b) => b.group === name),
  }));
  protected readonly pageLinks = computed(() =>
    this.pages.items().map((p) => ({ slug: p.slug, title: p.title })),
  );
  protected readonly widths: Record<Device, string> = {
    desktop: '100%',
    tablet: '768px',
    mobile: '390px',
  };

  constructor() {
    // Update the canvas in place; reloading the frame would lose the scroll position.
    effect(() => {
      this.frameReady();
      const blocks = this.history.value;
      const theme = this.site();
      const selected = this.selectedId();
      const document_ = this.frame()?.nativeElement.contentDocument;
      const style = document_?.getElementById('site-style');
      if (!document_ || !style || !theme) return;
      style.textContent = siteCss(theme) + EDITOR_CSS;
      const main = document_.getElementById('canvas')!;
      const html =
        renderBlocks(blocks, this.context(true)) ||
        '<div class="placeholder">This page is empty. Add a block from the left.</div>';
      if (main.dataset['html'] !== html) {
        main.innerHTML = html;
        main.dataset['html'] = html;
      }
      main.querySelectorAll('.is-selected').forEach((el) => el.classList.remove('is-selected'));
      if (selected)
        main
          .querySelector(`[data-block-id="${CSS.escape(selected)}"]`)
          ?.classList.add('is-selected');
    });
  }

  /** Angular would strip the style element from a plain string; this markup is a constant of ours. */
  protected readonly shellHtml = this.sanitizer.bypassSecurityTrustHtml(
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="site-style"></style></head><body><main id="canvas"></main></body></html>',
  );

  /** Only for sandboxed frames without scripts; all user text in it is already escaped. */
  protected trusted(html: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  ngOnInit(): void {
    void this.sites.load();
    void this.library.load();
  }

  /** The frame runs no scripts, so selection is handled from here. */
  protected frameLoaded(): void {
    const document_ = this.frame()?.nativeElement.contentDocument;
    if (!document_) return;
    document_.addEventListener('click', (event) => {
      event.preventDefault();
      const block = (event.target as Element).closest<HTMLElement>('[data-block-id]');
      this.selectedId.set(block?.dataset['blockId'] ?? null);
      this.target.set(null);
    });
    document_.addEventListener('submit', (event) => event.preventDefault());
    this.listenForDrags(document_);
    document_.addEventListener('keydown', (event) => this.keys(event));
    this.frameReady.update((n) => n + 1);
  }

  /** Handles blocks dragged from the palette or moved within the canvas. */
  private listenForDrags(canvas: Document): void {
    const clear = () =>
      canvas
        .querySelectorAll('.drop-before,.drop-after,.drop-into')
        .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
    const ours = (event: DragEvent) =>
      event.dataTransfer?.types.some((t) => t === DRAG_NEW || t === DRAG_MOVE);
    // Elements come from the frame's own document, so test by shape rather than with instanceof.
    const under = (event: DragEvent): Element | null => {
      const node = event.target as Node | null;
      return node?.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
    };
    canvas.addEventListener('dragstart', (event) => {
      const block = under(event)?.closest<HTMLElement>('[data-block-id]');
      if (!block || !event.dataTransfer) return;
      event.dataTransfer.setData(DRAG_MOVE, block.dataset['blockId']!);
      event.dataTransfer.effectAllowed = 'move';
    });
    canvas.addEventListener('dragover', (event) => {
      // Never let the frame navigate to a dropped file or link.
      event.preventDefault();
      if (!ours(event)) return;
      clear();
      const target = dropTargetAt(under(event), event.clientY);
      if (target.kind === 'column') {
        canvas
          .querySelector(`[data-column="${CSS.escape(target.parentId)}|${target.column}"]`)
          ?.classList.add('drop-into');
      } else if (target.kind !== 'end') {
        canvas
          .querySelector(`[data-block-id="${CSS.escape(target.id)}"]`)
          ?.classList.add(`drop-${target.kind}`);
      }
    });
    canvas.addEventListener('drop', (event) => {
      event.preventDefault();
      clear();
      const target = dropTargetAt(under(event), event.clientY);
      this.dropOnCanvas(
        event.dataTransfer?.getData(DRAG_NEW) ?? '',
        event.dataTransfer?.getData(DRAG_MOVE) ?? '',
        target,
      );
    });
    canvas.addEventListener('dragend', clear);
  }

  private dropOnCanvas(kind: string, moveId: string, target: DropTarget): void {
    if (!this.pageId()) return;
    if (kind && blockDef(kind)) {
      const block = createBlock(kind);
      this.commit(placeBlock(this.history.value, block, target));
      this.selectedId.set(block.id);
    } else if (moveId) {
      const next = moveBlock(this.history.value, moveId, target);
      if (next !== this.history.value) {
        this.commit(next);
        this.selectedId.set(moveId);
      }
    }
    this.target.set(null);
  }

  protected paletteDrag(event: DragEvent, kind: string): void {
    event.dataTransfer?.setData(DRAG_NEW, kind);
  }

  protected dropPage(event: CdkDragDrop<unknown>): void {
    if (event.previousIndex === event.currentIndex) return;
    const ids = this.pages.items().map((p) => p.id);
    void this.pages.reorder(moveItem(ids, event.previousIndex, event.currentIndex));
  }

  protected async renamePage(page: { id: string; title: string }): Promise<void> {
    const title = await this.ui.prompt('Page title', page.title);
    if (title) this.pages.patch(page.id, { title: title.slice(0, 200) }, 0);
  }

  protected columnColor(index: number): string {
    return String((this.selected()?.props['columnColors'] as string[] | undefined)?.[index] ?? '');
  }

  protected setColumnColor(index: number, color: string): void {
    const colors = [...((this.selected()?.props['columnColors'] as string[] | undefined) ?? [])];
    while (colors.length <= index) colors.push('');
    colors[index] = color;
    this.setProps({ columnColors: colors });
  }

  protected async chooseFavicon(): Promise<void> {
    const siteId = this.siteId();
    const [item] = await this.ui.pickMedia(['image']);
    if (item && this.siteId() === siteId) this.theme({ faviconMediaId: item.id });
  }

  protected faviconName(id: string): string {
    return this.library.byId(id)?.title ?? 'Missing file';
  }

  private context(editing: boolean): RenderContext {
    return {
      editing,
      mediaSrc: (id) => new URL(mediaUrl(id), location.origin).href,
      pageHref: () => '#',
    };
  }

  private async attempt(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.ui.error(error);
    }
  }

  // --- Sites ----------------------------------------------------------------
  protected async createSite(event: Event, template: string): Promise<void> {
    event.preventDefault();
    const name = String(new FormData(event.target as HTMLFormElement).get('name') ?? '').trim();
    const chosen: Template = TEMPLATES.find((t) => t.name === template) ?? TEMPLATES[0]!;
    if (!name || this.busy()) return;
    this.busy.set(true);
    await this.attempt(async () => {
      const site = await this.sites.create({ name, themeColor: chosen.themeColor });
      await this.pages.create({
        parentId: site.id,
        title: 'Home',
        slug: 'home',
        blocks: chosen.blocks(name).map((b) => this.linkHome(b)),
      });
      this.creating.set(false);
      await this.openSite(site.id);
    });
    this.busy.set(false);
  }

  private linkHome(block: SiteBlock): SiteBlock {
    return block.kind === 'header'
      ? { ...block, props: { ...block.props, items: [{ label: 'Home', url: 'page:home' }] } }
      : block;
  }

  protected async openSite(id: string): Promise<void> {
    this.siteId.set(id);
    this.pageId.set(null);
    this.history.reset([]);
    await this.pages.load(id);
    this.openPage(this.pages.items()[0]?.id ?? null);
  }

  protected async closeSite(): Promise<void> {
    await this.pages.flushAll();
    await this.sites.flushAll();
    this.siteId.set(null);
    this.pageId.set(null);
  }

  protected async removeSite(site: Site): Promise<void> {
    if (
      await this.ui.confirm(
        `Delete the website “${site.name}”?`,
        'All of its pages will be deleted.',
      )
    ) {
      await this.attempt(() => this.sites.remove(site.id));
    }
  }

  protected theme(patch: Partial<SiteTheme>): void {
    this.sites.patch(this.siteId()!, patch);
  }

  // --- Pages ----------------------------------------------------------------
  protected openPage(id: string | null): void {
    this.pageId.set(id);
    this.selectedId.set(null);
    this.target.set(null);
    this.history.reset(this.pages.byId(id)?.blocks ?? []);
  }

  private slugs(except?: string): string[] {
    return this.pages
      .items()
      .filter((p) => p.id !== except)
      .map((p) => p.slug);
  }

  protected async addPage(copy: boolean): Promise<void> {
    const title = await this.ui.prompt(
      'Page title',
      copy ? `${this.page()?.title} copy` : 'New page',
      'Add page',
    );
    if (!title) return;
    await this.attempt(async () => {
      const created = await this.pages.create({
        parentId: this.siteId()!,
        title,
        slug: uniqueSlug(title, this.slugs()),
        blocks: copy ? this.history.value.map(cloneBlock) : [],
      });
      this.openPage(created.id);
    });
  }

  protected setPage(patch: Partial<PageData>): void {
    this.pages.patch(this.pageId()!, patch);
  }

  /** Changing a page address also updates links that pointed at the old one. */
  protected setSlug(value: string): void {
    const page = this.page()!;
    const slug = uniqueSlug(value, this.slugs(page.id));
    if (slug === page.slug) return;
    const relink = (blocks: SiteBlock[]): SiteBlock[] =>
      JSON.parse(JSON.stringify(blocks), (_k, v) =>
        v === `page:${page.slug}` ? `page:${slug}` : v,
      ) as SiteBlock[];
    this.pages.patch(page.id, { slug });
    for (const other of this.pages.items()) {
      const blocks = other.id === page.id ? this.history.value : other.blocks;
      const next = relink(blocks);
      if (JSON.stringify(next) === JSON.stringify(blocks)) continue;
      this.pages.patch(other.id, { blocks: next });
      if (other.id === page.id) this.history.reset(next);
    }
  }

  protected movePage(by: number): void {
    const ids = this.pages.items().map((p) => p.id);
    const from = ids.indexOf(this.pageId()!);
    void this.pages.reorder(moveItem(ids, from, from + by));
  }

  protected async removePage(): Promise<void> {
    const page = this.page();
    if (!page || this.pages.items().length < 2) return;
    if (!(await this.ui.confirm(`Delete the page “${page.title}”?`))) return;
    await this.attempt(async () => {
      await this.pages.remove(page.id);
      this.openPage(this.pages.items()[0]?.id ?? null);
    });
  }

  // --- Blocks ---------------------------------------------------------------
  private persist(): void {
    const id = this.pageId();
    if (id) this.pages.patch(id, { blocks: this.history.value });
  }

  private commit(blocks: SiteBlock[], key = ''): void {
    this.history.commit(blocks, key);
    this.persist();
  }

  protected undo(): void {
    this.history.undo();
    this.persist();
  }

  protected redo(): void {
    this.history.redo();
    this.persist();
  }

  protected add(kind: string): void {
    if (!this.pageId()) return;
    const block = createBlock(kind);
    const target = this.target();
    if (target && findBlock(this.history.value, target.id)) {
      this.commit(insertIntoColumn(this.history.value, target.id, target.column, block));
    } else {
      this.commit(insertAfter(this.history.value, this.selectedId(), block));
    }
    this.selectedId.set(block.id);
    this.target.set(null);
  }

  private edit(change: (block: SiteBlock) => SiteBlock, key: string): void {
    const id = this.selectedId();
    if (id) this.commit(updateBlock(this.history.value, id, change), `${id}:${key}`);
  }

  protected setProps(patch: Props): void {
    this.edit(
      (b) =>
        b.kind === 'tabs' && Array.isArray(patch['items'])
          ? syncTabs(b, patch['items'] as { key?: string }[])
          : { ...b, props: { ...b.props, ...patch } },
      Object.keys(patch).join(),
    );
    if (this.selected()?.kind === 'tabs') this.target.set(null);
  }

  /** An empty value removes the override, returning to the theme default. */
  protected setStyle(patch: Props): void {
    this.edit(
      (b) => {
        const style: Record<string, unknown> = { ...b.style, ...patch };
        for (const [key, value] of Object.entries(patch)) {
          if (value === '' || value === undefined || value === false) delete style[key];
          else if (key === 'fontWeight') style[key] = Number(value);
        }
        return { ...b, style };
      },
      `style:${Object.keys(patch).join()}`,
    );
  }

  protected styleNumber(key: string, element: HTMLInputElement, min: number, max: number): void {
    const value =
      element.value === '' ? '' : Math.min(max, Math.max(min, Number(element.value) || min));
    element.value = String(value);
    this.setStyle({ [key]: value });
  }

  protected styleValue(key: string): string {
    return String((this.selected()?.style as Record<string, unknown> | undefined)?.[key] ?? '');
  }

  protected async backgroundImage(): Promise<void> {
    const id = this.selectedId();
    const [item] = await this.ui.pickMedia(['image']);
    if (item && this.selectedId() === id) this.setStyle({ backgroundImage: item.id });
  }

  protected columnCount(count: number): void {
    this.target.set(null);
    this.edit((b) => setColumnCount(b, count), 'columns');
  }

  protected shift(by: number): void {
    this.commit(shiftBlock(this.history.value, this.selectedId()!, by));
  }

  protected duplicate(): void {
    this.commit(duplicateBlock(this.history.value, this.selectedId()!));
  }

  protected remove(): void {
    const id = this.selectedId();
    if (!id) return;
    this.commit(removeBlock(this.history.value, id));
    this.selectedId.set(null);
    this.target.set(null);
  }

  protected drop(event: CdkDragDrop<unknown>): void {
    if (event.previousIndex !== event.currentIndex) {
      this.commit(moveItem(this.history.value, event.previousIndex, event.currentIndex));
    }
  }

  protected label(kind: string): string {
    return blockDef(kind)?.label ?? kind;
  }

  // --- Preview and export ----------------------------------------------------
  protected preview(): void {
    const page = this.page();
    const theme = this.site();
    if (!page || !theme) return;
    this.previewHtml.set(
      pageHtml(theme, { ...page, blocks: this.history.value }, this.context(true), {
        inline: siteCss(theme),
      }).replace(/ data-block-id="[^"]*"/g, ''),
    );
  }

  protected async exportSite(): Promise<void> {
    const theme = this.site();
    if (!theme || this.busy()) return;
    this.busy.set(true);
    await this.attempt(async () => {
      await this.library.load();
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const pages: PageData[] = this.pages
        .items()
        .map((p) => (p.id === this.pageId() ? { ...p, blocks: this.history.value } : p));
      const assets = new Map<string, string>();
      const used = new Set<string>();
      let missing = 0;
      const wanted = collectMedia(pages);
      if (theme.faviconMediaId) wanted.add(theme.faviconMediaId);
      for (const id of wanted) {
        const item = this.library.byId(id);
        const response = item ? await fetch(mediaUrl(id)) : null;
        if (!item || !response?.ok) {
          missing++;
          continue;
        }
        const name = uniqueName(safeFilename(mediaFilename(item)).replace(/[^\w.-]+/g, '-'), used);
        assets.set(id, name);
        zip.file(`assets/${name}`, await response.blob());
      }
      for (const [name, content] of buildSite(theme, pages, assets)) zip.file(name, content);
      downloadBlob(await zip.generateAsync({ type: 'blob' }), `${theme.name}.zip`);
      if (missing) this.ui.toast(`${missing} missing file(s) were left out of the export`, 'error');
      else this.ui.success('Website exported. Unzip it and upload the files to any web host.');
    });
    this.busy.set(false);
  }

  protected keys(event: KeyboardEvent): void {
    if (!this.siteId() || isTyping(event) || this.previewHtml() !== null) return;
    if (handleHistoryKey(event, this.history as History<unknown>)) {
      this.persist();
      return;
    }
    if (!this.selectedId()) return;
    if (event.key === 'Delete') this.remove();
    else if (event.key === 'Escape') this.selectedId.set(null);
    else return;
    event.preventDefault();
  }
}
