import { Component, computed, ElementRef, inject, OnInit, signal, viewChild } from '@angular/core';
import { injectCollection, type Doc } from '../../core/collection';
import { handleHistoryKey, History } from '../../core/history';
import { mediaUrl } from '../../core/media';
import { Ui } from '../../core/ui';
import { clamp, isTyping, loadImage, moveItem, trackPointer, uid } from '../../core/util';
import { Slider } from '../../shared/widgets';
import { CropModal, type CropArea } from './crop-modal';
import { PageView, type BookElement, type Page } from './page-view';

interface Book extends Doc {
  title: string;
  coverColor: string;
  pageLimit: number | null;
}

type BookPage = Doc & Page;

const element = (patch: Partial<BookElement>): BookElement => ({
  id: uid(),
  type: 'text',
  x: 0.15,
  y: 0.15,
  width: 0.7,
  height: 0.12,
  rotation: 0,
  text: '',
  fontSize: 24,
  fontFamily: 'serif',
  color: '#1f2937',
  bold: false,
  italic: false,
  align: 'left',
  mediaId: null,
  crop: null,
  shape: 'rectangle',
  fill: '#c7d2fe',
  ...patch,
});

@Component({
  selector: 'app-books',
  imports: [PageView, Slider, CropModal],
  host: { '(document:keydown)': 'keys($event)', '[class]': '"books"' },
  templateUrl: './books.html',
  styleUrl: './books.scss',
})
export class Books implements OnInit {
  protected readonly books = injectCollection<Book>('books');
  protected readonly pages = injectCollection<BookPage>('bookPages');
  private readonly ui = inject(Ui);
  protected readonly round = Math.round;
  protected readonly url = mediaUrl;
  private readonly canvas = viewChild<ElementRef<HTMLElement>>('canvas');

  protected readonly bookId = signal<string | null>(null);
  protected readonly book = computed(() => this.books.byId(this.bookId()));
  protected readonly pageId = signal<string | null>(null);
  protected readonly mode = signal<'edit' | 'read' | 'print'>('edit');
  protected readonly selectedId = signal<string | null>(null);
  /** Undo history of the open page's elements. */
  protected readonly history = new History<BookElement[]>([]);
  protected readonly pageIndex = computed(() =>
    Math.max(
      0,
      this.pages.items().findIndex((p) => p.id === this.pageId()),
    ),
  );
  protected readonly page = computed<BookPage | null>(() => {
    const stored = this.pages.byId(this.pageId());
    return stored ? { ...stored, elements: this.history.value } : null;
  });
  protected readonly selected = computed(
    () => this.history.value.find((e) => e.id === this.selectedId()) ?? null,
  );
  protected readonly turning = signal<BookPage | null>(null);
  protected readonly readIndex = signal(0);

  ngOnInit(): void {
    void this.books.load();
  }

  private async attempt(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.ui.error(error);
    }
  }

  // --- Library --------------------------------------------------------------
  protected async createBook(): Promise<void> {
    const title = await this.ui.prompt('Book title', '', 'Create');
    if (!title) return;
    await this.attempt(async () => {
      const book = await this.books.create({ title });
      await this.pages.create({
        parentId: book.id,
        background: book.coverColor,
        elements: [
          element({
            text: title,
            fontSize: 48,
            bold: true,
            align: 'center',
            color: '#ffffff',
            y: 0.3,
            height: 0.3,
          }),
        ],
      });
      await this.openBook(book.id);
    });
  }

  protected async openBook(id: string): Promise<void> {
    this.bookId.set(id);
    this.mode.set('edit');
    this.pageId.set(null);
    this.history.reset([]);
    await this.pages.load(id);
    this.openPage(this.pages.items()[0]?.id ?? null);
  }

  protected async closeBook(): Promise<void> {
    await this.pages.flushAll();
    this.bookId.set(null);
    this.pageId.set(null);
  }

  protected async removeBook(book: Book): Promise<void> {
    if (!(await this.ui.confirm(`Delete “${book.title}”?`, 'All of its pages will be deleted.')))
      return;
    await this.attempt(() => this.books.remove(book.id));
  }

  protected async renameBook(book: Book): Promise<void> {
    const title = await this.ui.prompt('Book title', book.title);
    if (title) this.books.patch(book.id, { title }, 0);
  }

  protected async setLimit(book: Book): Promise<void> {
    const raw = await this.ui.prompt('Page limit (0 for no limit)', String(book.pageLimit ?? 0));
    if (raw === null) return;
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000)
      this.ui.toast('Enter a whole number up to 1000', 'error');
    else this.books.patch(book.id, { pageLimit: limit || null }, 0);
  }

  // --- Pages ----------------------------------------------------------------
  protected openPage(id: string | null): void {
    this.pageId.set(id);
    this.selectedId.set(null);
    this.history.reset(this.pages.byId(id)?.elements ?? []);
  }

  protected label(index: number): string {
    return index === 0
      ? 'Cover'
      : index === this.pages.items().length - 1
        ? 'Back'
        : `Page ${index + 1}`;
  }

  protected async addPage(copy = false): Promise<void> {
    const current = this.page();
    await this.attempt(async () => {
      const created = await this.pages.create({
        parentId: this.bookId()!,
        background: copy && current ? current.background : '#ffffff',
        elements: copy && current ? current.elements.map((e) => ({ ...e, id: uid() })) : [],
      });
      // Place it right after the page being viewed.
      const ids = this.pages
        .items()
        .map((p) => p.id)
        .filter((id) => id !== created.id);
      ids.splice(current ? ids.indexOf(current.id) + 1 : ids.length, 0, created.id);
      await this.reorder(ids);
      this.openPage(created.id);
    });
  }

  private async reorder(ids: string[]): Promise<void> {
    await this.pages.reorder(ids);
  }

  protected shiftPage(by: number): void {
    const from = this.pageIndex();
    void this.reorder(
      moveItem(
        this.pages.items().map((p) => p.id),
        from,
        from + by,
      ),
    );
  }

  protected async removePage(): Promise<void> {
    const page = this.page();
    if (!page || !(await this.ui.confirm('Delete this page?'))) return;
    const index = this.pageIndex();
    await this.attempt(async () => {
      await this.pages.remove(page.id);
      this.openPage(this.pages.items()[Math.min(index, this.pages.items().length - 1)]?.id ?? null);
    });
  }

  protected background(color: string): void {
    this.pages.patch(this.pageId()!, { background: color });
  }

  // --- Elements -------------------------------------------------------------
  private persist(): void {
    const id = this.pageId();
    if (id) this.pages.patch(id, { elements: this.history.value });
  }

  private commit(elements: BookElement[], key = ''): void {
    this.history.commit(elements, key);
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

  private add(item: BookElement): void {
    this.commit([...this.history.value, item]);
    this.selectedId.set(item.id);
  }

  protected addText(): void {
    this.add(element({ text: 'New text' }));
  }

  protected addShape(shape: BookElement['shape']): void {
    this.add(
      element({
        type: 'shape',
        shape,
        width: 0.4,
        height: shape === 'line' ? 0.03 : 0.2,
        fill: shape === 'line' ? '#111827' : '#c7d2fe',
      }),
    );
  }

  protected async addImage(replace = false): Promise<void> {
    const pageId = this.pageId();
    const targetId = this.selectedId();
    const [media] = await this.ui.pickMedia(['image']);
    // The page may have changed while the picker was open.
    if (!media || this.pageId() !== pageId) return;
    if (replace && targetId) {
      this.change(targetId, { mediaId: media.id, crop: null });
      return;
    }
    await this.attempt(async () => {
      const image = await loadImage(mediaUrl(media.id));
      const height = clamp((0.6 * 3 * image.height) / (4 * image.width), 0.05, 0.8);
      this.add(element({ type: 'image', mediaId: media.id, width: 0.6, height, x: 0.2, y: 0.1 }));
    });
  }

  protected change(id: string, patch: Partial<BookElement>, key = ''): void {
    this.commit(
      this.history.value.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      key,
    );
  }

  protected set(patch: Partial<BookElement>): void {
    const id = this.selectedId();
    if (id) this.change(id, patch, `${id}:${Object.keys(patch).join()}`);
  }

  /** Id of the picture element whose crop is being dragged out. */
  protected readonly cropping = signal<string | null>(null);

  protected cropTarget(): BookElement | null {
    return this.history.value.find((e) => e.id === this.cropping()) ?? null;
  }

  protected cropped(area: CropArea | undefined): void {
    const id = this.cropping();
    this.cropping.set(null);
    if (id && area) this.change(id, { crop: area });
  }

  protected setCrop(side: 'x' | 'y' | 'w' | 'h', percent: number): void {
    const crop = {
      ...(this.selected()?.crop ?? { x: 0, y: 0, w: 1, h: 1 }),
      [side]: percent / 100,
    };
    crop.w = clamp(crop.w, 0.05, 1 - crop.x);
    crop.h = clamp(crop.h, 0.05, 1 - crop.y);
    this.set({ crop });
  }

  protected deleteSelected(): void {
    this.commit(this.history.value.filter((e) => e.id !== this.selectedId()));
    this.selectedId.set(null);
  }

  protected duplicateSelected(): void {
    const source = this.selected();
    if (source)
      this.add({
        ...source,
        id: uid(),
        x: clamp(source.x + 0.03, 0, 0.95),
        y: clamp(source.y + 0.03, 0, 0.95),
      });
  }

  protected layer(by: number): void {
    const from = this.history.value.findIndex((e) => e.id === this.selectedId());
    this.commit(moveItem(this.history.value, from, from + by));
  }

  /** Moves or resizes with a live preview, recording a single undo step on release. */
  protected gesture({
    event,
    element: start,
    mode,
  }: {
    event: PointerEvent;
    element: BookElement;
    mode: 'move' | 'resize';
  }): void {
    const box = this.canvas()!.nativeElement.getBoundingClientRect();
    const original = this.history.value;
    const pageId = this.pageId();
    trackPointer(
      event,
      ({ dx, dy }) => {
        if (this.pageId() !== pageId) return;
        const patch =
          mode === 'move'
            ? {
                x: clamp(start.x + dx / box.width, -start.width + 0.05, 0.95),
                y: clamp(start.y + dy / box.height, -start.height + 0.05, 0.95),
              }
            : {
                width: clamp(start.width + dx / box.width, 0.05, 1.5),
                height: clamp(start.height + dy / box.height, 0.02, 1.5),
              };
        this.history.preview(original.map((e) => (e.id === start.id ? { ...e, ...patch } : e)));
      },
      ({ moved, cancelled }) => {
        if (this.pageId() !== pageId) return;
        if (cancelled || !moved) this.history.cancelPreview();
        else {
          this.history.commitPreview();
          this.persist();
        }
      },
    );
  }

  protected keys(event: KeyboardEvent): void {
    if (this.mode() === 'read') {
      if (event.key === 'ArrowRight') this.turn(1);
      if (event.key === 'ArrowLeft') this.turn(-1);
      return;
    }
    if (!this.bookId() || this.mode() !== 'edit' || isTyping(event)) return;
    if (handleHistoryKey(event, this.history as History<unknown>)) {
      this.persist();
      return;
    }
    const current = this.selected();
    if (!current) return;
    const step = event.shiftKey ? 0.05 : 0.005;
    const nudge: Record<string, Partial<BookElement>> = {
      ArrowLeft: { x: current.x - step },
      ArrowRight: { x: current.x + step },
      ArrowUp: { y: current.y - step },
      ArrowDown: { y: current.y + step },
    };
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.deleteSelected();
    } else if (nudge[event.key]) {
      event.preventDefault();
      this.change(current.id, nudge[event.key]!, `nudge:${current.id}`);
    }
  }

  // --- Reading and printing -------------------------------------------------
  protected read(): void {
    this.readIndex.set(this.pageIndex());
    this.turning.set(null);
    this.mode.set('read');
  }

  protected turn(by: number): void {
    const next = this.readIndex() + by;
    if (next < 0 || next >= this.pages.items().length) return;
    this.turning.set(this.pages.items()[this.readIndex()]!);
    this.readIndex.set(next);
  }

  protected async print(): Promise<void> {
    const previous = this.mode();
    this.mode.set('print');
    // Wait for the print layout to render and its pictures to load.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await Promise.all(
      Array.from(document.querySelectorAll<HTMLImageElement>('.print-area img'), (img) =>
        img.decode().catch(() => undefined),
      ),
    );
    window.print();
    this.mode.set(previous);
  }
}
