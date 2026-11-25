import { CdkDrag, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnInit,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { injectCollection } from '../../core/collection';
import { handleHistoryKey, History } from '../../core/history';
import { MediaLibrary, mediaUrl, type MediaItem } from '../../core/media';
import { ProjectSaver, type Project } from '../../core/project';
import { Ui } from '../../core/ui';
import {
  canvasBlob,
  clamp,
  downloadBlob,
  isTyping,
  loadImage,
  moveItem,
  pickFiles,
  safeFilename,
  trackPointer,
  uid,
} from '../../core/util';
import { Slider } from '../../shared/widgets';
import { folderPath, folderSummaries } from '../files/library-utils';
import { AnnotationLayer } from './annotation-layer';
import { browserHost, createSourceCache } from './browser-host';
import { buildPdf } from './export';
import { displaySize, mergeRects, moveAnnotation, rectFrom, toDisplay, toPage } from './geometry';
import {
  emptyDoc,
  totalRotation,
  type Annotation,
  type PageRef,
  type PdfDoc,
  type Point,
  type Rect,
  type Rotation,
} from './model';
import { PdfPageCanvas } from './page-canvas';
import { openPdf } from './pdfjs';
import { SignaturePad } from './signature-pad';

type Tool =
  | 'select'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'pen'
  | 'marker'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'text'
  | 'comment'
  | 'stamp'
  | 'whiteout'
  | 'redact'
  | 'snapshot';

interface FormField {
  source: string;
  name: string;
  type: 'text' | 'check' | 'choice';
  options: string[];
  initial: string | boolean;
}

const A4 = { width: 595.28, height: 841.89 };
const TEXT_TOOLS: Tool[] = ['highlight', 'underline', 'strike'];
const STAMPS = [
  'APPROVED',
  'REJECTED',
  'DRAFT',
  'CONFIDENTIAL',
  'PAID',
  'COPY',
  'URGENT',
  'REVIEWED',
];

const blankPage = (): PageRef => ({
  key: uid(),
  source: null,
  index: 0,
  ...A4,
  baseRotation: 0,
  rotation: 0,
});

/** Size in points of an upright text box. */
export function measureText(text: string, size: number, bold: boolean): { w: number; h: number } {
  const context = document.createElement('canvas').getContext('2d')!;
  context.font = `${bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
  const lines = text.split('\n');
  return {
    w: Math.max(size, ...lines.map((l) => context.measureText(l).width)) + 6,
    h: lines.length * size * 1.2 + 4,
  };
}

@Component({
  selector: 'app-pdf-editor',
  imports: [AnnotationLayer, CdkDrag, CdkDropList, PdfPageCanvas, SignaturePad, Slider],
  host: { '(document:keydown)': 'keys($event)' },
  templateUrl: './pdf-editor.html',
  styleUrl: './pdf-editor.scss',
})
export class PdfEditor implements OnInit {
  /** Library id to open, from the ?media= query parameter. */
  readonly media = input<string>();

  protected readonly library = inject(MediaLibrary);
  private readonly ui = inject(Ui);
  private readonly router = inject(Router);
  protected readonly projects = injectCollection<Project<PdfDoc>>('pdfProjects');
  private readonly saver = new ProjectSaver<PdfDoc>(this.projects, (e) => this.ui.error(e));
  private readonly sourceBytes = createSourceCache();

  private readonly stage = viewChild<ElementRef<HTMLElement>>('stage');
  private readonly sheet = viewChild<ElementRef<HTMLElement>>('sheet');

  protected readonly history = new History<PdfDoc>(emptyDoc());
  protected readonly opened = signal<{ name: string; mediaId: string | null } | null>(null);
  protected readonly busy = signal('');
  protected readonly documents = signal<ReadonlyMap<string, PDFDocumentProxy>>(new Map());
  protected readonly pageKey = signal<string | null>(null);
  protected readonly zoom = signal(1.2);
  protected readonly tool = signal<Tool>('select');
  protected readonly selectedId = signal<string | null>(null);
  protected readonly color = signal('#e11d48');
  protected readonly highlightColor = signal('#facc15');
  protected readonly strokeWidth = signal(2);
  protected readonly fontSize = signal(16);
  protected readonly fill = signal('');
  protected readonly stampText = signal(STAMPS[0]!);
  protected readonly signing = signal(false);
  protected readonly marquee = signal<Rect | null>(null);
  protected readonly draft = signal<Annotation | null>(null);
  protected readonly searchText = signal('');
  protected readonly searchHits = signal<{ key: string; number: number; snippet: string }[] | null>(
    null,
  );
  protected readonly formFields = signal<FormField[]>([]);
  protected readonly checked = signal<ReadonlySet<string>>(new Set());

  protected readonly stamps = STAMPS;
  protected readonly roundValue = Math.round;
  protected readonly zoomLabel = () => `${Math.round(this.zoom() * 100)}%`;
  protected readonly swatches = ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#fb923c'];
  protected readonly tools: { id: Tool; label: string; icon: string }[] = [
    { id: 'select', label: 'Select', icon: '↖' },
    { id: 'highlight', label: 'Highlight', icon: '🖍' },
    { id: 'underline', label: 'Underline', icon: 'U̲' },
    { id: 'strike', label: 'Strikeout', icon: 'S̶' },
    { id: 'pen', label: 'Pen', icon: '✏️' },
    { id: 'marker', label: 'Marker', icon: '🖊' },
    { id: 'text', label: 'Text', icon: 'T' },
    { id: 'comment', label: 'Comment', icon: '💬' },
    { id: 'rect', label: 'Rectangle', icon: '▭' },
    { id: 'ellipse', label: 'Ellipse', icon: '◯' },
    { id: 'line', label: 'Line', icon: '╱' },
    { id: 'arrow', label: 'Arrow', icon: '➔' },
    { id: 'stamp', label: 'Stamp', icon: '🔖' },
    { id: 'whiteout', label: 'Whiteout', icon: '⬜' },
    { id: 'redact', label: 'Redact', icon: '⬛' },
    { id: 'snapshot', label: 'Snapshot', icon: '📷' },
  ];

  protected readonly doc = computed(() => this.history.value);
  protected readonly pageIndex = computed(() =>
    Math.max(
      0,
      this.doc().pages.findIndex((p) => p.key === this.pageKey()),
    ),
  );
  protected readonly page = computed<PageRef | null>(
    () => this.doc().pages[this.pageIndex()] ?? null,
  );
  protected readonly marks = computed(() => {
    const key = this.page()?.key;
    const draft = this.draft();
    const list = this.doc().annotations.filter((a) => a.page === key);
    return draft && draft.page === key ? [...list, draft] : list;
  });
  protected readonly selected = computed(
    () => this.doc().annotations.find((a) => a.id === this.selectedId()) ?? null,
  );
  protected readonly selectingText = computed(() => TEXT_TOOLS.includes(this.tool()));
  protected readonly comments = computed(() =>
    this.doc().annotations.flatMap((a) =>
      a.type === 'comment'
        ? [{ mark: a, number: this.doc().pages.findIndex((p) => p.key === a.page) + 1 }]
        : [],
    ),
  );
  protected readonly folderId = signal<string | null>(null);
  protected readonly folderPath = computed(() =>
    folderPath(this.library.folders(), this.folderId()),
  );
  protected readonly pdfs = computed(() =>
    this.library.items().filter((m) => m.kind === 'pdf' && m.folderId === this.folderId()),
  );
  /** Subfolders of the open folder, each with how many PDFs it holds at any depth. */
  protected readonly pdfFolders = computed(() => {
    const summaries = folderSummaries(
      this.library.folders(),
      this.library.items().filter((m) => m.kind === 'pdf'),
    );
    return this.library
      .folders()
      .filter((f) => (f.folderParentId ?? null) === this.folderId())
      .map((folder) => ({ folder, count: summaries.get(folder.id)?.count ?? 0 }))
      .sort((a, b) => a.folder.name.localeCompare(b.folder.name));
  });
  protected readonly saved = computed(() =>
    [...this.projects.items()].sort((a, b) => b.updatedAt - a.updatedAt),
  );

  private savedRevision = 0;
  private openToken = 0;

  constructor() {
    // Autosave every recorded change.
    effect(() => {
      const revision = this.history.revision();
      const opened = this.opened();
      if (!opened || revision === this.savedRevision) return;
      this.savedRevision = revision;
      untracked(() =>
        this.saver.save({ name: opened.name, mediaId: opened.mediaId, doc: this.history.value }),
      );
    });
  }

  async ngOnInit(): Promise<void> {
    await Promise.all([this.library.load(), this.projects.load()]);
    const id = this.media();
    const item = this.library.byId(id);
    if (item?.kind === 'pdf') await this.openFile(item);
  }

  // --- Opening --------------------------------------------------------------
  private async loadDocument(sourceId: string): Promise<PDFDocumentProxy> {
    const existing = this.documents().get(sourceId);
    if (existing) return existing;
    const proxy = await openPdf(await this.sourceBytes(sourceId));
    this.documents.update((map) => new Map(map).set(sourceId, proxy));
    return proxy;
  }

  private async pagesOf(sourceId: string): Promise<PageRef[]> {
    const proxy = await this.loadDocument(sourceId);
    const pages: PageRef[] = [];
    for (let i = 0; i < proxy.numPages; i++) {
      const page = await proxy.getPage(i + 1);
      const [x0, y0, x1, y1] = page.view as [number, number, number, number];
      pages.push({
        key: uid(),
        source: sourceId,
        index: i,
        width: x1 - x0,
        height: y1 - y0,
        baseRotation: (((page.rotate % 360) + 360) % 360) as Rotation,
        rotation: 0,
      });
    }
    return pages;
  }

  private async show(
    name: string,
    mediaId: string | null,
    doc: PdfDoc,
    projectId: string | null,
  ): Promise<void> {
    this.saver.open(projectId);
    this.history.reset(doc);
    this.savedRevision = 0;
    this.pageKey.set(doc.pages[0]?.key ?? null);
    this.selectedId.set(null);
    this.searchHits.set(null);
    this.checked.set(new Set());
    this.tool.set('select');
    this.opened.set({ name, mediaId });
    await this.loadForms(doc);
  }

  private async run(label: string, work: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(label);
    try {
      await work();
    } catch (error) {
      this.ui.error(error);
    } finally {
      this.busy.set('');
    }
  }

  protected async openFile(item: MediaItem): Promise<void> {
    const token = ++this.openToken;
    await this.run('Opening PDF…', async () => {
      const project = this.saved().find((p) => p.mediaId === item.id);
      if (project) {
        await this.resumeProject(project);
        return;
      }
      const pages = await this.pagesOf(item.id);
      if (token === this.openToken) await this.show(item.title, item.id, emptyDoc(pages), null);
    });
  }

  private async resumeProject(project: Project<PdfDoc>): Promise<void> {
    const sources = new Set(
      project.doc.pages.map((p) => p.source).filter((s): s is string => s !== null),
    );
    for (const source of sources) await this.loadDocument(source);
    await this.show(project.name, project.mediaId, { ...emptyDoc(), ...project.doc }, project.id);
  }

  protected resume(project: Project<PdfDoc>): void {
    void this.run('Opening project…', () => this.resumeProject(project));
  }

  protected async deleteProject(project: Project<PdfDoc>): Promise<void> {
    if (
      !(await this.ui.confirm(
        `Delete the saved edit “${project.name}”?`,
        'The PDF in your library is not affected.',
      ))
    )
      return;
    try {
      await this.projects.remove(project.id);
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected async newBlank(): Promise<void> {
    const name = await this.ui.prompt('Name your PDF', 'Untitled', 'Create');
    if (!name) return;
    await this.show(name, null, emptyDoc([blankPage()]), null);
    this.saver.save({ name, mediaId: null, doc: this.history.value });
  }

  protected async newPdfFolder(): Promise<void> {
    const name = await this.ui.prompt('New folder name', '', 'Create');
    if (!name) return;
    try {
      await this.library.createFolder(name, this.folderId());
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected async uploadPdf(): Promise<void> {
    const [file] = await pickFiles('application/pdf', false);
    if (!file) return;
    try {
      const item = await this.library.upload(file, file.name, this.folderId());
      if (item.kind !== 'pdf') this.ui.toast('That file is not a PDF', 'error');
      else await this.openFile(item);
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected async fromImages(): Promise<void> {
    const images = await this.ui.pickMedia(['image'], true);
    if (!images.length) return;
    await this.run('Building PDF…', async () => {
      const { PDFDocument } = await import('pdf-lib');
      const host = browserHost(this.sourceBytes);
      const output = await PDFDocument.create();
      for (const image of images) {
        const embedded = await output.embedPng(await host.imagePng(mediaUrl(image.id)));
        // Fit each picture on an A4 page that matches its orientation.
        const landscape = embedded.width > embedded.height;
        const size = landscape ? [A4.height, A4.width] : [A4.width, A4.height];
        const page = output.addPage(size as [number, number]);
        const scale = Math.min((size[0]! - 40) / embedded.width, (size[1]! - 40) / embedded.height);
        const w = embedded.width * scale;
        const h = embedded.height * scale;
        page.drawImage(embedded, {
          x: (size[0]! - w) / 2,
          y: (size[1]! - h) / 2,
          width: w,
          height: h,
        });
      }
      const bytes = await output.save();
      const item = await this.library.upload(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
        'Pictures.pdf',
      );
      const pages = await this.pagesOf(item.id);
      await this.show(item.title, item.id, emptyDoc(pages), null);
    });
  }

  protected async closeDocument(): Promise<void> {
    await this.saver.flush();
    this.saver.open(null);
    this.opened.set(null);
    this.history.reset(emptyDoc());
    this.savedRevision = 0;
    if (this.media()) await this.router.navigate(['/pdf']);
  }

  // --- Editing --------------------------------------------------------------
  private commit(patch: Partial<PdfDoc>, key = ''): void {
    this.history.commit({ ...this.history.value, ...patch }, key);
  }

  private add(mark: Annotation, select = false): void {
    this.commit({ annotations: [...this.doc().annotations, mark] });
    if (select) {
      this.selectedId.set(mark.id);
      this.tool.set('select');
    }
  }

  protected change(id: string, patch: object, key = ''): void {
    this.commit(
      {
        annotations: this.doc().annotations.map((a) =>
          a.id === id ? ({ ...a, ...patch } as Annotation) : a,
        ),
      },
      key,
    );
  }

  /** Re-measures a text box while keeping its top-left corner where it is. */
  protected editText(patch: { text?: string; size?: number; bold?: boolean }): void {
    const mark = this.selected();
    const page = this.page();
    if (mark?.type !== 'text' || !page) return;
    const next = { ...mark, ...patch };
    const box = measureText(next.text, next.size, next.bold);
    const shown = displaySize(page.width, page.height, mark.rot);
    const center = toDisplay(mark.center, mark.rot);
    const moved = toPage(
      {
        x: center.x + (box.w - mark.w) / 2 / shown.width,
        y: center.y + (box.h - mark.h) / 2 / shown.height,
      },
      mark.rot,
    );
    this.change(mark.id, { ...patch, ...box, center: moved }, `text:${mark.id}`);
  }

  protected scaleBox(percent: number): void {
    const mark = this.selected();
    if (mark?.type !== 'image' && mark?.type !== 'stamp') return;
    const w = percent;
    this.change(mark.id, { w, h: (mark.h / mark.w) * w }, `size:${mark.id}`);
  }

  protected deleteSelected(): void {
    const id = this.selectedId();
    if (!id) return;
    this.commit({ annotations: this.doc().annotations.filter((a) => a.id !== id) });
    this.selectedId.set(null);
  }

  /** Pointer position as a fraction of the page as currently shown. */
  private shownPoint(event: PointerEvent): Point {
    const box = this.sheet()!.nativeElement.getBoundingClientRect();
    return {
      x: clamp((event.clientX - box.left) / box.width, 0, 1),
      y: clamp((event.clientY - box.top) / box.height, 0, 1),
    };
  }

  protected async pointerDown(event: PointerEvent): Promise<void> {
    const page = this.page();
    const tool = this.tool();
    if (!page || event.button !== 0 || this.selectingText()) return;
    if (tool === 'select') {
      if (!(event.target as Element).closest('.mark')) this.selectedId.set(null);
      return;
    }
    event.preventDefault();
    const rotation = totalRotation(page);
    const start = this.shownPoint(event);
    const base = { id: uid(), page: page.key, color: this.color() };

    if (tool === 'comment') {
      const text = await this.ui.prompt('Comment', '', 'Add comment');
      if (text) this.add({ ...base, type: 'comment', at: toPage(start, rotation), text }, true);
    } else if (tool === 'text') {
      const text = await this.ui.prompt('Text to add', '', 'Add text');
      if (!text) return;
      const size = this.fontSize();
      const box = measureText(text, size, false);
      const shown = displaySize(page.width, page.height, rotation);
      const center = toPage(
        { x: start.x + box.w / 2 / shown.width, y: start.y + box.h / 2 / shown.height },
        rotation,
      );
      this.add(
        { ...base, type: 'text', text, size, bold: false, center, ...box, rot: rotation },
        true,
      );
    } else if (tool === 'stamp') {
      this.add(
        {
          ...base,
          type: 'stamp',
          text: this.stampText(),
          center: toPage(start, rotation),
          w: 170,
          h: 48,
          rot: rotation,
        },
        true,
      );
    } else {
      this.dragDraw(event, page, tool, base, start);
    }
  }

  private dragDraw(
    event: PointerEvent,
    page: PageRef,
    tool: Tool,
    base: { id: string; page: string; color: string },
    start: Point,
  ): void {
    const rotation = totalRotation(page);
    const points: Point[] = [toPage(start, rotation)];
    const build = (end: Point): Annotation | null => {
      const box = () => rectFrom(toPage(start, rotation), toPage(end, rotation));
      const width = this.strokeWidth();
      switch (tool) {
        case 'pen':
          return { ...base, type: 'ink', points: [...points], width, opacity: 1 };
        case 'marker':
          return {
            ...base,
            color: this.highlightColor(),
            type: 'ink',
            points: [...points],
            width: width * 6,
            opacity: 0.4,
          };
        case 'line':
        case 'arrow':
          return {
            ...base,
            type: tool,
            from: toPage(start, rotation),
            to: toPage(end, rotation),
            width,
          };
        case 'rect':
        case 'ellipse':
          return { ...base, type: tool, box: box(), width, fill: this.fill() };
        case 'whiteout':
          return { ...base, color: '#ffffff', type: 'whiteout', box: box() };
        case 'redact':
          return { ...base, color: '#000000', type: 'redact', box: box() };
        default:
          return null;
      }
    };
    let end = start;
    trackPointer(
      event,
      ({ event: move }) => {
        end = this.shownPoint(move);
        if (tool === 'pen' || tool === 'marker') points.push(toPage(end, rotation));
        if (tool === 'snapshot') this.marquee.set(rectFrom(start, end));
        else this.draft.set(build(end));
      },
      ({ moved, cancelled }) => {
        this.draft.set(null);
        this.marquee.set(null);
        if (cancelled) return;
        if (tool === 'snapshot') {
          if (moved) void this.snapshot(rectFrom(start, end));
          return;
        }
        // A bare click makes a dot with the pen but nothing for shapes.
        if (!moved && tool !== 'pen' && tool !== 'marker') return;
        const mark = build(end);
        if (mark) this.add(mark);
      },
    );
  }

  protected grab({ event, mark }: { event: PointerEvent; mark: Annotation }): void {
    const box = this.sheet()!.nativeElement.getBoundingClientRect();
    const page = this.page()!;
    const rotation = totalRotation(page);
    const original = this.history.value;
    // Convert the movement the user sees into movement on the unrotated page.
    const delta = (dx: number, dy: number) => {
      const zero = toPage({ x: 0, y: 0 }, rotation);
      const moved = toPage({ x: dx / box.width, y: dy / box.height }, rotation);
      return { x: moved.x - zero.x, y: moved.y - zero.y };
    };
    trackPointer(
      event,
      ({ dx, dy }) => {
        const d = delta(dx, dy);
        this.history.preview({
          ...original,
          annotations: original.annotations.map((a) =>
            a.id === mark.id ? moveAnnotation(a, d.x, d.y) : a,
          ),
        });
      },
      ({ moved, cancelled }) => {
        if (cancelled || !moved) this.history.cancelPreview();
        else this.history.commitPreview();
      },
    );
  }

  /** Turns the current text selection into highlight, underline or strike-through marks. */
  protected markSelection(): void {
    const tool = this.tool();
    const page = this.page();
    const sheet = this.sheet()?.nativeElement;
    const selection = window.getSelection();
    if (!page || !sheet || !selection || selection.isCollapsed || !this.selectingText()) return;
    if (!sheet.contains(selection.anchorNode) || !sheet.contains(selection.focusNode)) return;
    const box = sheet.getBoundingClientRect();
    const rotation = totalRotation(page);
    const rects: Rect[] = [];
    for (let i = 0; i < selection.rangeCount; i++) {
      for (const r of selection.getRangeAt(i).getClientRects()) {
        // Skip the container-sized boxes some browsers report alongside the text boxes.
        if (r.height > box.height * 0.2 && r.width > box.width * 0.8) continue;
        const a = {
          x: clamp((r.left - box.left) / box.width, 0, 1),
          y: clamp((r.top - box.top) / box.height, 0, 1),
        };
        const b = {
          x: clamp((r.right - box.left) / box.width, 0, 1),
          y: clamp((r.bottom - box.top) / box.height, 0, 1),
        };
        rects.push(rectFrom(a, b));
      }
    }
    const lines = mergeRects(rects).map((r) =>
      rectFrom(toPage(r, rotation), toPage({ x: r.x + r.w, y: r.y + r.h }, rotation)),
    );
    if (lines.length) {
      this.add({
        id: uid(),
        page: page.key,
        type: tool as 'highlight' | 'underline' | 'strike',
        rects: lines,
        rot: rotation,
        color: tool === 'highlight' ? this.highlightColor() : this.color(),
        text: selection.toString().slice(0, 2000),
      });
    }
    selection.removeAllRanges();
  }

  private async snapshot(area: Rect): Promise<void> {
    const sheet = this.sheet()!.nativeElement;
    const source = sheet.querySelector('canvas')!;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(area.w * source.width));
    canvas.height = Math.max(1, Math.round(area.h * source.height));
    canvas
      .getContext('2d')!
      .drawImage(
        source,
        area.x * source.width,
        area.y * source.height,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    if (area.w < 0.01 || area.h < 0.01) return;
    try {
      await this.library.upload(
        await canvasBlob(canvas),
        `${safeFilename(this.opened()!.name)} snapshot.png`,
      );
      this.ui.success('Snapshot of the page saved to your library');
    } catch (error) {
      this.ui.error(error);
    }
  }

  private insertImage(src: string, width: number, height: number, pageKey: string): void {
    const page = this.doc().pages.find((p) => p.key === pageKey);
    if (!page) return;
    const rotation = totalRotation(page);
    const shown = displaySize(page.width, page.height, rotation);
    const w = Math.min(220, shown.width * 0.6);
    this.add(
      {
        id: uid(),
        page: page.key,
        color: '#000000',
        type: 'image',
        src,
        w,
        h: (w * height) / width,
        center: { x: 0.5, y: 0.5 },
        rot: rotation,
      },
      true,
    );
  }

  protected async addPicture(): Promise<void> {
    const key = this.page()?.key;
    const [item] = await this.ui.pickMedia(['image']);
    if (!item || !key) return;
    try {
      const image = await loadImage(mediaUrl(item.id));
      this.insertImage(mediaUrl(item.id), image.naturalWidth, image.naturalHeight, key);
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected signed(result: { url: string; width: number; height: number } | null): void {
    this.signing.set(false);
    const key = this.page()?.key;
    if (result && key) this.insertImage(result.url, result.width, result.height, key);
  }

  // --- Pages ----------------------------------------------------------------
  protected goTo(index: number): void {
    const page = this.doc().pages[clamp(index, 0, this.doc().pages.length - 1)];
    if (!page) return;
    this.pageKey.set(page.key);
    this.selectedId.set(null);
    window.getSelection()?.removeAllRanges();
    this.stage()?.nativeElement.scrollTo(0, 0);
  }

  protected thumbScale(page: PageRef): number {
    return 130 / displaySize(page.width, page.height, totalRotation(page)).width;
  }

  protected documentFor(page: PageRef): PDFDocumentProxy | null {
    return page.source ? (this.documents().get(page.source) ?? null) : null;
  }

  protected rotate(by: 90 | 270): void {
    const key = this.page()?.key;
    this.commit({
      pages: this.doc().pages.map((p) =>
        p.key === key ? { ...p, rotation: ((p.rotation + by) % 360) as Rotation } : p,
      ),
    });
  }

  protected movePage(from: number, to: number): void {
    this.commit({ pages: moveItem(this.doc().pages, from, to) });
  }

  protected dropPage(event: CdkDragDrop<unknown>): void {
    if (event.previousIndex !== event.currentIndex)
      this.movePage(event.previousIndex, event.currentIndex);
  }

  protected insertBlank(): void {
    const added = blankPage();
    const pages = [...this.doc().pages];
    pages.splice(this.pageIndex() + 1, 0, added);
    this.commit({ pages });
    this.pageKey.set(added.key);
  }

  protected duplicatePage(): void {
    const source = this.page();
    if (!source) return;
    const copy = { ...source, key: uid() };
    const pages = [...this.doc().pages];
    pages.splice(this.pageIndex() + 1, 0, copy);
    const marks = this.doc()
      .annotations.filter((a) => a.page === source.key)
      .map((a) => ({ ...a, id: uid(), page: copy.key }));
    this.commit({ pages, annotations: [...this.doc().annotations, ...marks] });
    this.pageKey.set(copy.key);
  }

  /** The pages ticked in the rail, or just the current one. */
  private targets(): Set<string> {
    const keys = new Set(
      this.doc()
        .pages.map((p) => p.key)
        .filter((k) => this.checked().has(k)),
    );
    if (!keys.size && this.page()) keys.add(this.page()!.key);
    return keys;
  }

  protected deletePages(): void {
    const keys = this.targets();
    if (keys.size >= this.doc().pages.length) {
      this.ui.toast('A PDF needs at least one page', 'error');
      return;
    }
    const index = this.pageIndex();
    const pages = this.doc().pages.filter((p) => !keys.has(p.key));
    this.commit({ pages, annotations: this.doc().annotations.filter((a) => !keys.has(a.page)) });
    this.checked.set(new Set());
    this.goTo(Math.min(index, pages.length - 1));
  }

  protected toggleCheck(key: string): void {
    this.checked.update((set) => {
      const next = new Set(set);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  protected async mergePdf(): Promise<void> {
    const items = await this.ui.pickMedia(['pdf'], true);
    if (!items.length) return;
    const name = this.opened()!.name;
    await this.run('Adding pages…', async () => {
      const added: PageRef[] = [];
      for (const item of items) added.push(...(await this.pagesOf(item.id)));
      if (this.opened()?.name !== name) return;
      this.commit({ pages: [...this.doc().pages, ...added] });
      await this.loadForms(this.doc());
      this.ui.success(`Added ${added.length} pages at the end`);
    });
  }

  // --- Search and forms -----------------------------------------------------
  protected async search(event: Event): Promise<void> {
    event.preventDefault();
    const needle = this.searchText().trim().toLowerCase();
    if (!needle) {
      this.searchHits.set(null);
      return;
    }
    await this.run('Searching…', async () => {
      const hits: { key: string; number: number; snippet: string }[] = [];
      for (const [index, page] of this.doc().pages.entries()) {
        const proxy = this.documentFor(page);
        if (!proxy) continue;
        const content = await (await proxy.getPage(page.index + 1)).getTextContent();
        const text = content.items
          .map((i) => ('str' in i ? i.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ');
        const at = text.toLowerCase().indexOf(needle);
        if (at >= 0)
          hits.push({
            key: page.key,
            number: index + 1,
            snippet: text.slice(Math.max(0, at - 25), at + needle.length + 35),
          });
      }
      this.searchHits.set(hits);
      if (hits[0]) this.goTo(hits[0].number - 1);
    });
  }

  private async loadForms(doc: PdfDoc): Promise<void> {
    this.formFields.set([]);
    const sources = [
      ...new Set(doc.pages.map((p) => p.source).filter((s): s is string => s !== null)),
    ];
    if (!sources.length) return;
    try {
      const lib = await import('pdf-lib');
      const fields: FormField[] = [];
      for (const source of sources) {
        const pdf = await lib.PDFDocument.load(await this.sourceBytes(source));
        for (const field of pdf.getForm().getFields()) {
          const name = field.getName();
          if (field instanceof lib.PDFTextField) {
            fields.push({
              source,
              name,
              type: 'text',
              options: [],
              initial: field.getText() ?? '',
            });
          } else if (field instanceof lib.PDFCheckBox) {
            fields.push({ source, name, type: 'check', options: [], initial: field.isChecked() });
          } else if (field instanceof lib.PDFDropdown || field instanceof lib.PDFOptionList) {
            fields.push({
              source,
              name,
              type: 'choice',
              options: field.getOptions(),
              initial: field.getSelected()[0] ?? '',
            });
          } else if (field instanceof lib.PDFRadioGroup) {
            fields.push({
              source,
              name,
              type: 'choice',
              options: field.getOptions(),
              initial: field.getSelected() ?? '',
            });
          }
        }
      }
      this.formFields.set(fields);
    } catch {
      // Encrypted or unusual PDFs simply offer no form panel; export reports the reason.
    }
  }

  protected formValue(field: FormField): string | boolean {
    return this.doc().forms[field.source]?.[field.name] ?? field.initial;
  }

  protected setForm(field: FormField, value: string | boolean): void {
    const forms = this.doc().forms;
    this.commit(
      { forms: { ...forms, [field.source]: { ...forms[field.source], [field.name]: value } } },
      `form:${field.name}`,
    );
  }

  protected setWatermark(patch: Partial<NonNullable<PdfDoc['watermark']>>): void {
    const current = this.doc().watermark ?? { text: '', color: '#6b7280', opacity: 0.25, size: 56 };
    const next = { ...current, ...patch };
    this.commit({ watermark: next.text ? next : null }, 'watermark');
  }

  protected setPageNumbers(pageNumbers: boolean): void {
    this.commit({ pageNumbers });
  }

  // --- Export ---------------------------------------------------------------
  private async bytes(only?: ReadonlySet<string>): Promise<Blob> {
    const output = await buildPdf(this.history.value, browserHost(this.sourceBytes), only);
    return new Blob([output as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
  }

  protected download(): void {
    void this.run('Preparing download…', async () =>
      downloadBlob(await this.bytes(), `${this.opened()!.name} (edited).pdf`),
    );
  }

  protected saveCopy(): void {
    void this.run('Saving to library…', async () => {
      await this.library.upload(
        await this.bytes(),
        `${safeFilename(this.opened()!.name)} (edited).pdf`,
      );
      this.ui.success('Saved a new PDF to your library. The original is unchanged.');
    });
  }

  protected extract(): void {
    const keys = this.targets();
    void this.run('Extracting pages…', async () =>
      downloadBlob(await this.bytes(keys), `${this.opened()!.name} (pages).pdf`),
    );
  }

  protected split(): void {
    void this.run('Splitting…', async () => {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      for (const [index, page] of this.doc().pages.entries()) {
        this.busy.set(`Splitting page ${index + 1}…`);
        zip.file(
          `page-${String(index + 1).padStart(3, '0')}.pdf`,
          await this.bytes(new Set([page.key])),
        );
      }
      downloadBlob(await zip.generateAsync({ type: 'blob' }), `${this.opened()!.name} (split).zip`);
    });
  }

  protected keys(event: KeyboardEvent): void {
    if (!this.opened() || isTyping(event)) return;
    if (handleHistoryKey(event, this.history as History<unknown>)) return;
    if (event.key === 'PageDown') this.goTo(this.pageIndex() + 1);
    else if (event.key === 'PageUp') this.goTo(this.pageIndex() - 1);
    else if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedId())
      this.deleteSelected();
    else if (event.key === 'Escape') {
      this.selectedId.set(null);
      this.tool.set('select');
      return;
    } else return;
    event.preventDefault();
  }
}
