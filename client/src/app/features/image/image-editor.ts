import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnInit,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
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
import { rectFrom } from '../pdf/geometry';
import type { Point, Rect } from '../pdf/model';
import {
  applyCrop,
  BLEND_MODES,
  CANVAS_PRESETS,
  createLayer,
  emptyImageDoc,
  flip,
  FONTS,
  hitTest,
  layout,
  NEUTRAL,
  normalizeAngle,
  PRESETS,
  resetCrop,
  resizeCanvas,
  resizeLayer,
  rotateQuarter,
  type Adjustments,
  type ImageDoc,
  type Layer,
  type ShapeKind,
  type Stroke,
} from './model';
import { renderDoc, renderPhoto, textHeight } from './render';
import type { Band } from '../../shared/band';
import { BandPanel } from '../../shared/band-panel';
import { SECTIONS, sizeForPhoto, type SectionKey } from './sections';
import {
  cutOut,
  drawSelection,
  freehand,
  magicWand,
  resizeBounds,
  type Selection,
} from './selection';

type Tool = 'move' | 'draw' | 'erase' | 'crop' | 'eyedropper' | 'lasso';
const MAX_SIDE = 4096;
const STICKERS = [
  '😀',
  '😂',
  '😍',
  '😎',
  '🤔',
  '😭',
  '😡',
  '🥳',
  '👍',
  '👎',
  '👏',
  '🙏',
  '🔥',
  '✨',
  '⭐',
  '💯',
  '❤️',
  '💔',
  '🎉',
  '🎂',
  '🎁',
  '👑',
  '🕶️',
  '🎩',
  '💥',
  '💬',
  '❓',
  '❗',
  '✅',
  '❌',
  '➡️',
  '🐶',
  '🐱',
  '🌈',
  '☀️',
  '🌙',
];

@Component({
  selector: 'app-image-editor',
  imports: [Slider, BandPanel],
  host: { '(document:keydown)': 'keys($event)', '(document:paste)': 'paste($event)' },
  templateUrl: './image-editor.html',
  styleUrl: './image-editor.scss',
})
export class ImageEditor implements OnInit {
  readonly media = input<string>();
  /** Set when another module opens the editor on one picture and wants the result back. */
  readonly embedded = input<string>();
  readonly exported = output<MediaItem>();
  readonly dismissed = output<void>();

  protected readonly library = inject(MediaLibrary);
  private readonly ui = inject(Ui);
  private readonly router = inject(Router);
  protected readonly projects = injectCollection<Project<ImageDoc>>('imageProjects');
  private readonly saver = new ProjectSaver<ImageDoc>(this.projects, (e) => this.ui.error(e));
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly stage = viewChild<ElementRef<HTMLElement>>('stage');

  protected readonly history = new History<ImageDoc>(emptyImageDoc());
  protected readonly opened = signal<{ name: string; mediaId: string | null } | null>(null);
  protected readonly images = signal<ReadonlyMap<string, HTMLImageElement>>(new Map());
  protected readonly selectedId = signal<string | null>(null);
  protected readonly tool = signal<Tool>('move');
  protected readonly zoom = signal(0.5);
  protected readonly brushColor = signal('#ef4444');
  protected readonly brushSize = signal(12);
  protected readonly cropArea = signal<Rect | null>(null);
  protected readonly exportFormat = signal<'image/png' | 'image/jpeg' | 'image/webp'>('image/png');
  protected readonly exportQuality = signal(92);
  protected readonly exportScale = signal(100);
  protected readonly busy = signal(false);

  protected readonly doc = computed(() => this.history.value);
  protected readonly box = computed(() => layout(this.doc()));
  protected readonly selected = computed(
    () => this.doc().layers.find((l) => l.id === this.selectedId()) ?? null,
  );
  protected readonly layersTopFirst = computed(() => [...this.doc().layers].reverse());
  protected readonly pictures = computed(() =>
    this.library.items().filter((m) => m.kind === 'image'),
  );
  protected readonly saved = computed(() =>
    [...this.projects.items()].sort((a, b) => b.updatedAt - a.updatedAt),
  );

  protected readonly fonts = FONTS;
  protected readonly round = Math.round;
  protected readonly percent = (value: number) => Math.round(value * 100);
  protected readonly aligns = ['left', 'center', 'right'] as const;
  protected readonly sectionDefs = SECTIONS;
  protected readonly lassoMode = signal<'wand' | 'freehand'>('wand');
  protected readonly tolerance = signal(30);
  protected readonly selection = signal<Selection | null>(null);
  private readonly trail = signal<Point[]>([]);
  private readonly overlay = viewChild<ElementRef<HTMLCanvasElement>>('overlay');
  private wandSeed: Point | null = null;
  protected readonly corners = ['nw', 'ne', 'sw', 'se'] as const;
  protected readonly blendModes = BLEND_MODES;
  protected readonly presets = PRESETS;
  protected readonly canvasPresets = CANVAS_PRESETS;
  protected readonly stickers = STICKERS;
  protected readonly shapes: { id: ShapeKind; icon: string }[] = [
    { id: 'rect', icon: '▭' },
    { id: 'ellipse', icon: '◯' },
    { id: 'triangle', icon: '△' },
    { id: 'star', icon: '☆' },
    { id: 'hexagon', icon: '⬡' },
    { id: 'heart', icon: '♡' },
    { id: 'line', icon: '╱' },
    { id: 'arrow', icon: '➔' },
  ];
  protected readonly tools: { id: Tool; label: string }[] = [
    { id: 'move', label: '↖ Move' },
    { id: 'draw', label: '🖌 Brush' },
    { id: 'erase', label: '🧽 Eraser' },
    { id: 'crop', label: '✂ Crop' },
    { id: 'eyedropper', label: '💧 Pick colour' },
    { id: 'lasso', label: '🪄 Lasso' },
  ];
  protected readonly sliders: {
    key: keyof Adjustments;
    label: string;
    min: number;
    max: number;
    unit: string;
  }[] = [
    { key: 'brightness', label: 'Brightness', min: 0, max: 200, unit: '%' },
    { key: 'contrast', label: 'Contrast', min: 0, max: 200, unit: '%' },
    { key: 'saturation', label: 'Saturation', min: 0, max: 200, unit: '%' },
    { key: 'warmth', label: 'Warmth', min: -100, max: 100, unit: '' },
    { key: 'hue', label: 'Hue', min: -180, max: 180, unit: '°' },
    { key: 'grayscale', label: 'Grayscale', min: 0, max: 100, unit: '%' },
    { key: 'sepia', label: 'Sepia', min: 0, max: 100, unit: '%' },
    { key: 'invert', label: 'Invert', min: 0, max: 100, unit: '%' },
    { key: 'sharpen', label: 'Sharpen', min: 0, max: 100, unit: '%' },
    { key: 'blur', label: 'Blur', min: 0, max: 30, unit: 'px' },
    { key: 'pixelate', label: 'Pixelate', min: 0, max: 60, unit: 'px' },
    { key: 'vignette', label: 'Vignette', min: 0, max: 100, unit: '%' },
  ];

  /** The processed photo, rebuilt only when something that affects it changes. */
  private readonly photoKey = computed(() => {
    const d = this.doc();
    return JSON.stringify([
      d.base,
      d.rotation,
      d.flipH,
      d.flipV,
      d.crop,
      d.adjustments,
      d.background,
      d.background2,
    ]);
  });
  private readonly photo = computed(() => {
    this.photoKey();
    const images = this.images();
    return renderPhoto(untracked(this.doc), images);
  });

  private savedRevision = 0;
  private readonly requested = new Set<string>();

  constructor() {
    effect(() => {
      const target = this.canvas()?.nativeElement;
      if (target && this.opened()) renderDoc(target, this.doc(), this.images(), this.photo());
    });
    // Fetch any picture the document refers to, including after undo.
    effect(() => {
      const doc = this.doc();
      const ids = [doc.base.mediaId, ...doc.layers.map((l) => l.mediaId)].filter(
        (id): id is string => !!id,
      );
      untracked(() =>
        ids.forEach((id) => void this.ensureImage(id).catch((e) => this.ui.error(e))),
      );
    });
    effect(() => {
      const revision = this.history.revision();
      const opened = this.opened();
      if (!opened || revision === this.savedRevision) return;
      this.savedRevision = revision;
      untracked(() =>
        this.saver.save({
          name: opened.name,
          mediaId: opened.mediaId,
          doc: this.history.value,
          status: 'draft',
        }),
      );
    });
  }

  /** A selection only makes sense for the picture it was made on. */
  private readonly forgetSelection = effect(() => {
    this.history.revision();
    this.tool();
    this.opened();
    untracked(() => this.clearSelection());
  });

  private readonly paintSelection = effect(() => {
    const canvas = this.overlay()?.nativeElement;
    const selection = this.selection();
    const trail = this.trail();
    const box = this.box();
    if (!canvas) return;
    canvas.width = box.width;
    canvas.height = box.height;
    drawSelection(canvas, selection, trail);
  });

  async ngOnInit(): Promise<void> {
    await Promise.all([this.library.load(), this.projects.load()]);
    const item = this.library.byId(this.embedded() ?? this.media());
    if (item?.kind === 'image') await this.openPicture(item);
    // Embedded, there is nothing else to show: if the picture could not be opened, hand control back.
    if (this.embedded() && !this.opened()) {
      this.ui.toast('That picture could not be opened', 'error');
      this.dismissed.emit();
    }
  }

  private async ensureImage(id: string): Promise<HTMLImageElement | undefined> {
    const existing = this.images().get(id);
    if (existing) return existing;
    if (this.requested.has(id)) return undefined;
    this.requested.add(id);
    try {
      const image = await loadImage(mediaUrl(id));
      this.images.update((map) => new Map(map).set(id, image));
      return image;
    } catch {
      throw new Error('A picture used here is missing from the library');
    }
  }

  // --- Opening --------------------------------------------------------------
  private show(
    name: string,
    mediaId: string | null,
    doc: ImageDoc,
    projectId: string | null,
  ): void {
    this.saver.open(projectId);
    this.history.reset(doc);
    this.savedRevision = 0;
    this.selectedId.set(null);
    this.cropArea.set(null);
    this.tool.set('move');
    this.opened.set({ name, mediaId });
    setTimeout(() => this.fit());
  }

  protected async openPicture(item: MediaItem): Promise<void> {
    const project = this.saved().find((p) => p.mediaId === item.id);
    if (project) {
      this.resume(project);
      return;
    }
    try {
      const image = await loadImage(mediaUrl(item.id));
      this.requested.add(item.id);
      this.images.update((map) => new Map(map).set(item.id, image));
      // Very large photos are edited at a size every browser canvas can handle.
      const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
      const doc = emptyImageDoc(
        Math.max(1, Math.round(image.naturalWidth * scale)),
        Math.max(1, Math.round(image.naturalHeight * scale)),
        item.id,
      );
      this.show(item.title, item.id, doc, null);
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected resume(project: Project<ImageDoc>): void {
    const base = emptyImageDoc();
    this.show(project.name, project.mediaId, { ...base, ...project.doc }, project.id);
  }

  protected async uploadPicture(): Promise<void> {
    const [file] = await pickFiles('image/*', false);
    if (!file) return;
    try {
      const item = await this.library.upload(file, file.name);
      if (item.kind === 'image') await this.openPicture(item);
      else this.ui.toast('That file is not a picture', 'error');
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected newCanvas(width: number, height: number): void {
    const doc = emptyImageDoc(width, height);
    this.show('Untitled design', null, doc, null);
    this.saver.save({ name: 'Untitled design', mediaId: null, doc });
  }

  protected async rename(): Promise<void> {
    const opened = this.opened()!;
    const name = await this.ui.prompt('Name this design', opened.name);
    if (!name) return;
    this.opened.set({ ...opened, name });
    this.saver.save({ name, mediaId: opened.mediaId, doc: this.history.value });
  }

  protected async close(): Promise<void> {
    await this.saver.flush();
    if (this.embedded()) {
      this.dismissed.emit();
      return;
    }
    this.saver.open(null);
    this.opened.set(null);
    this.history.reset(emptyImageDoc());
    this.savedRevision = 0;
    if (this.media()) await this.router.navigate(['/image-editor']);
  }

  protected async deleteProject(project: Project<ImageDoc>): Promise<void> {
    if (!(await this.ui.confirm(`Delete the saved design “${project.name}”?`))) return;
    try {
      await this.projects.remove(project.id);
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected fit(): void {
    const stage = this.stage()?.nativeElement;
    const box = this.box();
    if (!stage) return;
    this.zoom.set(
      clamp(
        Math.min((stage.clientWidth - 48) / box.width, (stage.clientHeight - 48) / box.height),
        0.05,
        2,
      ),
    );
  }

  // --- Document changes -----------------------------------------------------
  private commit(next: ImageDoc, key = ''): void {
    this.history.commit(next, key);
  }

  protected set(patch: Partial<ImageDoc>, key = ''): void {
    this.commit({ ...this.doc(), ...patch }, key);
  }

  protected adjust(key: keyof Adjustments, value: number): void {
    this.set({ adjustments: { ...this.doc().adjustments, [key]: value } }, `adjust:${key}`);
  }

  protected preset(values: Partial<Adjustments>): void {
    this.set({ adjustments: { ...NEUTRAL, ...values } });
  }

  protected section(key: SectionKey, patch: Partial<Band>): void {
    const { width, height } = this.box().photo;
    const current = this.doc().sections[key];
    let next = { ...current, ...patch };
    if (next.enabled) next = sizeForPhoto(key, next, Math.min(width, height));
    this.set(
      { sections: { ...this.doc().sections, [key]: next } },
      `section:${key}:${Object.keys(patch).join()}`,
    );
    if ('enabled' in patch) setTimeout(() => this.fit());
  }

  protected photoStyle(patch: Partial<ImageDoc['photoStyle']>): void {
    this.set(
      { photoStyle: { ...this.doc().photoStyle, ...patch } },
      `photo:${Object.keys(patch).join()}`,
    );
  }

  protected clearDrawing(): void {
    this.set({ layers: this.doc().layers.filter((l) => l.type !== 'draw') });
  }

  protected frame(patch: Partial<ImageDoc['frame']>): void {
    this.set({ frame: { ...this.doc().frame, ...patch } }, `frame:${Object.keys(patch).join()}`);
  }

  protected rotate(clockwise: boolean): void {
    this.cropArea.set(null);
    this.commit(rotateQuarter(this.doc(), clockwise));
    setTimeout(() => this.fit());
  }

  protected flip(axis: 'h' | 'v'): void {
    this.commit(flip(this.doc(), axis));
  }

  protected confirmCrop(): void {
    const area = this.cropArea();
    if (!area || area.w < 0.02 || area.h < 0.02) return;
    this.commit(applyCrop(this.doc(), area));
    this.cropArea.set(null);
    this.tool.set('move');
    setTimeout(() => this.fit());
  }

  protected clearCrop(): void {
    this.commit(resetCrop(this.doc()));
    this.cropArea.set(null);
    setTimeout(() => this.fit());
  }

  protected resize(side: 'width' | 'height', value: string): void {
    const size = Math.round(Number(value));
    if (!Number.isFinite(size) || size < 16 || size > MAX_SIDE) {
      this.ui.toast(`Enter a size from 16 to ${MAX_SIDE}`, 'error');
      return;
    }
    const base = this.doc().base;
    this.commit(
      resizeCanvas(
        this.doc(),
        side === 'width' ? size : base.width,
        side === 'height' ? size : base.height,
      ),
    );
    setTimeout(() => this.fit());
  }

  // --- Layers ---------------------------------------------------------------
  private addLayer(layer: Layer): void {
    this.set({ layers: [...this.doc().layers, layer] });
    this.selectedId.set(layer.id);
    this.tool.set('move');
  }

  private centred(patch: Partial<Layer>): Partial<Layer> {
    const { photo } = this.box();
    return { x: photo.width / 2, y: photo.height / 2, ...patch };
  }

  private unit(): number {
    const { photo } = this.box();
    return Math.min(photo.width, photo.height);
  }

  protected addText(position: 'top' | 'bottom' | 'middle'): void {
    const { photo } = this.box();
    const fontSize = Math.round(this.unit() / 11);
    const layer = createLayer(
      'text',
      this.centred({
        text: position === 'middle' ? 'Your text' : `${position.toUpperCase()} TEXT`,
        fontSize,
        w: photo.width * 0.9,
        strokeWidth: position === 'middle' ? 0 : Math.max(2, Math.round(fontSize / 14)),
        fontFamily: position === 'middle' ? FONTS[0]!.value : FONTS[1]!.value,
        color: position === 'middle' && !this.doc().base.mediaId ? '#111827' : '#ffffff',
      }),
    );
    layer.h = textHeight(layer);
    if (position !== 'middle')
      layer.y = position === 'top' ? layer.h / 2 + 12 : photo.height - layer.h / 2 - 12;
    this.addLayer(layer);
  }

  protected addBubble(): void {
    const unit = this.unit();
    this.addLayer(
      createLayer(
        'bubble',
        this.centred({
          text: 'Hello!',
          w: unit * 0.5,
          h: unit * 0.3,
          fontSize: Math.round(unit / 18),
          fill: '#ffffff',
          color: '#111827',
        }),
      ),
    );
  }

  protected addSticker(text: string): void {
    const size = Math.round(this.unit() / 5);
    this.addLayer(
      createLayer(
        'sticker',
        this.centred({ text, fontSize: size, w: size * 1.25, h: size * 1.25 }),
      ),
    );
  }

  protected addShape(shape: ShapeKind): void {
    const unit = this.unit();
    const open = shape === 'line' || shape === 'arrow';
    this.addLayer(
      createLayer(
        'shape',
        this.centred({
          shape,
          w: unit * 0.35,
          h: open ? Math.max(24, unit * 0.06) : unit * 0.35,
          strokeWidth: open ? Math.max(4, Math.round(unit / 120)) : 0,
          stroke: open ? this.brushColor() : '#000000',
        }),
      ),
    );
  }

  private async placePicture(item: MediaItem): Promise<void> {
    const image = await loadImage(mediaUrl(item.id));
    const { photo } = this.box();
    const scale = Math.min(
      (photo.width * 0.6) / image.naturalWidth,
      (photo.height * 0.6) / image.naturalHeight,
    );
    this.addLayer(
      createLayer(
        'image',
        this.centred({
          mediaId: item.id,
          w: image.naturalWidth * scale,
          h: image.naturalHeight * scale,
        }),
      ),
    );
  }

  protected async addPictures(): Promise<void> {
    for (const item of await this.ui.pickMedia(['image'], true)) {
      await this.placePicture(item).catch((e) => this.ui.error(e));
    }
  }

  /** Pasting an image from the clipboard adds it as a layer. */
  protected async paste(event: ClipboardEvent): Promise<void> {
    if (!this.opened() || isTyping(event)) return;
    const file = Array.from(event.clipboardData?.files ?? []).find((f) =>
      f.type.startsWith('image/'),
    );
    if (!file) return;
    event.preventDefault();
    try {
      const folder = await this.library.ensureFolder('Editor uploads');
      await this.placePicture(await this.library.upload(file, file.name || 'pasted.png', folder));
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected layer(id: string, patch: Partial<Layer>, key = ''): void {
    this.set(
      {
        layers: this.doc().layers.map((l) => {
          if (l.id !== id) return l;
          const next = { ...l, ...patch };
          // Wrapped text changes height with its content and font.
          if (next.type === 'text') next.h = textHeight(next);
          return next;
        }),
      },
      key,
    );
  }

  protected edit(patch: Partial<Layer>): void {
    const id = this.selectedId();
    if (id) this.layer(id, patch, `${id}:${Object.keys(patch).join()}`);
  }

  protected editShadow(patch: Partial<Layer['shadow']>): void {
    this.edit({ shadow: { ...this.selected()!.shadow, ...patch } });
  }

  protected removeLayer(id = this.selectedId()): void {
    if (!id) return;
    this.set({ layers: this.doc().layers.filter((l) => l.id !== id) });
    if (this.selectedId() === id) this.selectedId.set(null);
  }

  protected duplicate(): void {
    const source = this.selected();
    if (source)
      this.addLayer({ ...structuredClone(source), id: uid(), x: source.x + 24, y: source.y + 24 });
  }

  protected reorder(by: number): void {
    const from = this.doc().layers.findIndex((l) => l.id === this.selectedId());
    if (from >= 0) this.set({ layers: moveItem(this.doc().layers, from, from + by) });
  }

  protected alignLayer(
    horizontal: 'left' | 'center' | 'right' | null,
    vertical: 'top' | 'middle' | 'bottom' | null,
  ): void {
    const layer = this.selected();
    if (!layer) return;
    const { photo } = this.box();
    const x =
      horizontal === 'left'
        ? layer.w / 2
        : horizontal === 'right'
          ? photo.width - layer.w / 2
          : horizontal
            ? photo.width / 2
            : layer.x;
    const y =
      vertical === 'top'
        ? layer.h / 2
        : vertical === 'bottom'
          ? photo.height - layer.h / 2
          : vertical
            ? photo.height / 2
            : layer.y;
    this.edit({ x, y });
  }

  protected layerName(layer: Layer): string {
    return layer.type === 'text' || layer.type === 'sticker' || layer.type === 'bubble'
      ? `${layer.text || layer.type}`
      : layer.type === 'shape'
        ? layer.shape
        : layer.type === 'draw'
          ? 'Drawing'
          : 'Picture';
  }

  // --- Pointer --------------------------------------------------------------
  /** Pointer position in photo pixels. */
  private point(event: PointerEvent): Point {
    const rect = this.canvas()!.nativeElement.getBoundingClientRect();
    const box = this.box();
    return {
      x: ((event.clientX - rect.left) / rect.width) * box.width - box.originX,
      y: ((event.clientY - rect.top) / rect.height) * box.height - box.originY,
    };
  }

  protected pointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    const at = this.point(event);
    switch (this.tool()) {
      case 'move': {
        const hit = hitTest(this.doc().layers, at.x, at.y);
        this.selectedId.set(hit?.id ?? null);
        if (hit) this.dragLayer(event, hit, 'move');
        break;
      }
      case 'draw':
      case 'erase':
        this.paint(event, at);
        break;
      case 'crop': {
        const { photo } = this.box();
        const fraction = (p: Point) => ({
          x: clamp(p.x / photo.width, 0, 1),
          y: clamp(p.y / photo.height, 0, 1),
        });
        const start = fraction(at);
        this.cropArea.set(null);
        trackPointer(event, ({ event: move }) =>
          this.cropArea.set(rectFrom(start, fraction(this.point(move)))),
        );
        break;
      }
      case 'lasso':
        this.startSelection(event, at);
        break;
      case 'eyedropper': {
        const canvas = this.canvas()!.nativeElement;
        const box = this.box();
        const pixel = canvas
          .getContext('2d')!
          .getImageData(
            clamp(Math.floor(at.x + box.originX), 0, canvas.width - 1),
            clamp(Math.floor(at.y + box.originY), 0, canvas.height - 1),
            1,
            1,
          ).data;
        const hex = `#${[pixel[0], pixel[1], pixel[2]].map((v) => v!.toString(16).padStart(2, '0')).join('')}`;
        this.brushColor.set(hex);
        const layer = this.selected();
        if (layer)
          this.edit(
            layer.type === 'shape' || layer.type === 'bubble' ? { fill: hex } : { color: hex },
          );
        this.ui.toast(`Picked ${hex}`);
        this.tool.set('move');
        break;
      }
    }
  }

  /** Move, resize or rotate with a live preview and one undo step per gesture. */
  protected dragLayer(event: PointerEvent, start: Layer, mode: 'move' | 'resize' | 'rotate'): void {
    event.stopPropagation();
    event.preventDefault();
    const original = this.history.value;
    const zoom = this.zoom();
    const rect = this.canvas()!.nativeElement.getBoundingClientRect();
    const box = this.box();
    const centre = {
      x: rect.left + (box.originX + start.x) * zoom,
      y: rect.top + (box.originY + start.y) * zoom,
    };
    trackPointer(
      event,
      ({ dx, dy, event: move }) => {
        let patch: Partial<Layer>;
        if (mode === 'move') patch = { x: start.x + dx / zoom, y: start.y + dy / zoom };
        else if (mode === 'resize')
          patch = resizeLayer(start, dx / zoom, dy / zoom, move.shiftKey || start.type === 'image');
        else {
          let angle =
            (Math.atan2(move.clientY - centre.y, move.clientX - centre.x) * 180) / Math.PI + 90;
          if (move.shiftKey) angle = Math.round(angle / 15) * 15;
          patch = { rotation: Math.round(normalizeAngle(angle)) };
        }
        this.history.preview({
          ...original,
          layers: original.layers.map((l) => (l.id === start.id ? { ...l, ...patch } : l)),
        });
      },
      ({ moved, cancelled }) => {
        if (cancelled || !moved) this.history.cancelPreview();
        else this.history.commitPreview();
      },
    );
  }

  /** Brush and eraser strokes go into the selected drawing layer, creating one if needed. */
  private paint(event: PointerEvent, at: Point): void {
    const original = this.history.value;
    const chosen = this.selected();
    let target =
      chosen?.type === 'draw' && !chosen.hidden && !chosen.locked
        ? chosen
        : [...original.layers].reverse().find((l) => l.type === 'draw' && !l.hidden && !l.locked);
    if (!target) {
      if (this.tool() === 'erase') {
        this.ui.toast('The eraser removes brush strokes. Draw something first.');
        return;
      }
      target = createLayer('draw', { x: 0, y: 0 });
    }
    const layer = target;
    const local = (p: Point) => [
      Math.round((p.x - layer.x) * 10) / 10,
      Math.round((p.y - layer.y) * 10) / 10,
    ];
    const stroke: Stroke = {
      points: local(at),
      color: this.brushColor(),
      size: this.brushSize(),
      erase: this.tool() === 'erase',
    };
    const withStroke = (): ImageDoc => {
      const next = {
        ...layer,
        strokes: [...layer.strokes, { ...stroke, points: [...stroke.points] }],
      };
      const exists = original.layers.some((l) => l.id === layer.id);
      return {
        ...original,
        layers: exists
          ? original.layers.map((l) => (l.id === layer.id ? next : l))
          : [...original.layers, next],
      };
    };
    this.history.preview(withStroke());
    trackPointer(
      event,
      ({ event: move }) => {
        stroke.points.push(...local(this.point(move)));
        this.history.preview(withStroke());
      },
      ({ cancelled }) => {
        if (cancelled) this.history.cancelPreview();
        else {
          this.history.commitPreview();
          this.selectedId.set(layer.id);
        }
      },
    );
  }

  // --- Lasso and magic wand --------------------------------------------------
  /** Pointer position in pixels of the whole composed picture. */
  private composed(photoPoint: Point): Point {
    const box = this.box();
    return { x: photoPoint.x + box.originX, y: photoPoint.y + box.originY };
  }

  protected clearSelection(): void {
    this.selection.set(null);
    this.trail.set([]);
    this.wandSeed = null;
  }

  private startSelection(event: PointerEvent, at: Point): void {
    this.clearSelection();
    const canvas = this.canvas()!.nativeElement;
    if (this.lassoMode() === 'wand') {
      this.wandSeed = this.composed(at);
      this.runWand();
      return;
    }
    const points = [this.composed(at)];
    trackPointer(
      event,
      ({ event: move }) => {
        points.push(this.composed(this.point(move)));
        this.trail.set([...points]);
      },
      () => {
        this.trail.set([]);
        this.selection.set(freehand(points, canvas.width, canvas.height));
      },
    );
  }

  private runWand(): void {
    const canvas = this.canvas()?.nativeElement;
    if (!canvas || !this.wandSeed) return;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    this.selection.set(
      magicWand(
        pixels.data,
        canvas.width,
        canvas.height,
        this.wandSeed.x,
        this.wandSeed.y,
        this.tolerance(),
      ),
    );
  }

  protected setTolerance(value: number): void {
    this.tolerance.set(value);
    this.runWand();
  }

  protected resizeSelection(event: PointerEvent, corner: 'nw' | 'ne' | 'sw' | 'se'): void {
    event.preventDefault();
    event.stopPropagation();
    const start = this.selection();
    if (!start) return;
    trackPointer(event, ({ event: move }) => {
      const to = this.composed(this.point(move));
      this.selection.set({
        ...start,
        bounds: resizeBounds(start.bounds, corner, to, start.width, start.height),
      });
    });
  }

  /** Copies the selection into the library, either as a new picture or as a movable layer. */
  protected async useSelection(asLayer: boolean): Promise<void> {
    const selection = this.selection();
    const canvas = this.canvas()?.nativeElement;
    const opened = this.opened();
    if (!selection || !canvas || !opened || this.busy()) return;
    const cut = cutOut(canvas, selection);
    const box = this.box();
    const { x, y, w, h } = selection.bounds;
    this.busy.set(true);
    try {
      const folder = asLayer ? await this.library.ensureFolder('Editor uploads') : null;
      const item = await this.library.upload(
        await canvasBlob(cut),
        `${safeFilename(opened.name)} cutout.png`,
        folder,
      );
      if (!asLayer) {
        this.ui.success('Saved the selection as a new picture in your library');
      } else if (this.opened() === opened) {
        await this.ensureImage(item.id);
        this.addLayer(
          createLayer('image', {
            mediaId: item.id,
            w,
            h,
            x: x - box.originX + w / 2,
            y: y - box.originY + h / 2,
          }),
        );
      }
      this.clearSelection();
    } catch (error) {
      this.ui.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  // --- Export ---------------------------------------------------------------
  private async exportBlob(): Promise<{ blob: Blob; name: string }> {
    // Every referenced picture must be loaded, or the export would silently miss it.
    const doc = this.doc();
    for (const id of [doc.base.mediaId, ...doc.layers.map((l) => l.mediaId)]) {
      if (id && !this.images().has(id))
        throw new Error('Pictures are still loading or missing. Try again in a moment.');
    }
    const canvas = document.createElement('canvas');
    const box = this.box();
    const scale = Math.min(this.exportScale() / 100, 8192 / Math.max(box.width, box.height));
    renderDoc(canvas, doc, this.images(), this.photo(), scale);
    const type = this.exportFormat();
    if (type === 'image/jpeg') {
      // JPEG has no transparency; paint white behind instead of black.
      const g = canvas.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'destination-over';
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, canvas.width, canvas.height);
    }
    const blob = await canvasBlob(canvas, type, this.exportQuality() / 100);
    const extension = blob.type.split('/')[1]!.replace('jpeg', 'jpg');
    return { blob, name: `${safeFilename(this.opened()!.name)} (edited).${extension}` };
  }

  protected async save(download: boolean): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const { blob, name } = await this.exportBlob();
      if (download) downloadBlob(blob, name);
      else {
        const revision = this.history.revision();
        const opened = this.opened()!;
        const result = await this.library.upload(blob, name);
        // Only mark it done if nothing changed while the file was being saved.
        if (this.opened() === opened && this.history.revision() === revision) {
          this.saver.save({
            name: opened.name,
            mediaId: opened.mediaId,
            doc: this.history.value,
            status: 'done',
          });
        }
        this.ui.success('Saved a new picture to your library. The original is unchanged.');
        if (this.embedded()) {
          await this.saver.flush();
          this.exported.emit(result);
        }
      }
    } catch (error) {
      this.ui.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected keys(event: KeyboardEvent): void {
    if (!this.opened() || isTyping(event)) return;
    if (handleHistoryKey(event, this.history as History<unknown>)) return;
    const layer = this.selected();
    const step = event.shiftKey ? 10 : 1;
    const nudges: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (event.key === 'Escape') {
      this.selectedId.set(null);
      this.cropArea.set(null);
      this.tool.set('move');
    } else if (event.key === 'Enter' && this.tool() === 'crop') {
      this.confirmCrop();
    } else if (layer && !layer.locked && nudges[event.key]) {
      const [dx, dy] = nudges[event.key]!;
      this.layer(layer.id, { x: layer.x + dx, y: layer.y + dy }, `nudge:${layer.id}`);
    } else if (layer && (event.key === 'Delete' || event.key === 'Backspace')) {
      this.removeLayer();
    } else if (layer && event.key.toLowerCase() === 'd' && (event.ctrlKey || event.metaKey)) {
      this.duplicate();
    } else return;
    event.preventDefault();
  }
}
