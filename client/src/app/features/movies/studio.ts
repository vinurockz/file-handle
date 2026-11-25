import { CdkDrag, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import {
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  InjectionToken,
  OnInit,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Api } from '../../core/api';
import { injectCollection, type Doc } from '../../core/collection';
import { handleHistoryKey, History } from '../../core/history';
import { MediaLibrary, mediaUrl, type MediaItem } from '../../core/media';
import { Ui } from '../../core/ui';
import {
  clamp,
  downloadBlob,
  formatTime,
  isTyping,
  moveItem,
  safeFilename,
  trackPointer,
  uid,
} from '../../core/util';
import { Modal, Slider } from '../../shared/widgets';
import { BandPanel } from '../../shared/band-panel';
import { ImageEditor } from '../image/image-editor';
import { FONTS } from '../image/model';
import { MovieEngine, recordMovie, type MovieData, type Recording } from './engine';
import {
  ANIMATIONS,
  ASPECTS,
  buildSlideshow,
  createBubble,
  createObject,
  createScene,
  movieLength,
  sceneAt,
  sceneOffset,
  setDuration,
  TRANSITIONS,
  type Aspect,
  type Bubble,
  movieBand,
  type MovieBand,
  type Scene,
  type SceneObject,
  type SlideSource,
  type Transition,
} from './model';

export const STUDIO = new InjectionToken<{ collection: 'movies' | 'slideshows'; title: string }>(
  'studio',
);

type Movie = Doc & MovieData & { title: string };
type Data = MovieData;

const emptyData = (): Data => ({
  aspect: '16:9',
  background: '#000000',
  clips: [],
  header: {},
  footer: {},
  musicMediaId: null,
  musicVolume: 0.5,
});

const dataOf = (m: Movie): Data => ({
  aspect: m.aspect,
  background: m.background,
  clips: m.clips as Scene[],
  header: m.header ?? {},
  footer: m.footer ?? {},
  musicMediaId: m.musicMediaId,
  musicVolume: m.musicVolume,
});

@Component({
  selector: 'app-movie-studio',
  imports: [Modal, Slider, CdkDrag, CdkDropList, BandPanel, ImageEditor],
  host: { '(document:keydown)': 'keys($event)' },
  templateUrl: './studio.html',
  styleUrl: './studio.scss',
})
export class MovieStudio implements OnInit {
  protected readonly config = inject(STUDIO);
  protected readonly store = injectCollection<Movie>(this.config.collection);
  protected readonly library = inject(MediaLibrary);
  private readonly api = inject(Api);
  private readonly ui = inject(Ui);
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  protected readonly openId = signal<string | null>(null);
  protected readonly movie = computed(() => this.store.byId(this.openId()));
  protected readonly history = new History<Data>(emptyData());
  protected readonly data = computed(() => this.history.value);
  protected readonly engine = new MovieEngine(() => untracked(this.data));
  protected readonly sceneId = signal<string | null>(null);
  protected readonly objectId = signal<string | null>(null);
  protected readonly bubbleId = signal<string | null>(null);
  protected readonly scene = computed(
    () => this.data().clips.find((s) => s.id === this.sceneId()) ?? null,
  );
  protected readonly object = computed(
    () => this.scene()?.objects.find((o) => o.id === this.objectId()) ?? null,
  );
  protected readonly bubble = computed(
    () => this.scene()?.bubbles.find((b) => b.id === this.bubbleId()) ?? null,
  );
  protected readonly total = computed(() => movieLength(this.data().clips));
  protected readonly creating = signal(false);
  protected readonly slideItems = signal<MediaItem[]>([]);
  protected readonly exportState = signal<{ label: string; progress: number } | null>(null);
  protected readonly lastExport = signal<string | null>(null);

  protected readonly aspects = Object.keys(ASPECTS) as Aspect[];
  protected readonly transitions = TRANSITIONS;
  protected readonly animations = ANIMATIONS;
  protected readonly fonts = FONTS;
  protected readonly bandNames = ['header', 'footer'] as const;
  protected readonly bandOf = movieBand;
  protected readonly time = formatTime;
  protected readonly round = Math.round;
  protected readonly length = movieLength;
  protected readonly url = mediaUrl;

  private recording: Recording | null = null;
  private cancelled = false;
  private destroyed = false;

  constructor() {
    effect(() => {
      const element = this.canvas()?.nativeElement ?? null;
      untracked(() => this.engine.attach(element));
    });
    effect(() => {
      this.data();
      untracked(() => {
        if (this.engine.time() > this.total()) this.engine.seek(this.total());
        else this.engine.sync(false);
      });
    });
    // Keep the selected scene following the playhead.
    effect(() => {
      const time = this.engine.time();
      if (!this.engine.playing()) return;
      untracked(() => {
        const at = sceneAt(this.data().clips, time);
        const id = at ? this.data().clips[at.index]!.id : null;
        if (id !== this.sceneId()) this.select(id);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.cancelled = true;
      this.recording?.cancel();
      this.engine.destroy();
    });
  }

  ngOnInit(): void {
    void this.store.load();
    void this.library.load();
  }

  private async attempt(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected mediaName(id: string): string {
    return this.library.byId(id)?.title ?? 'Missing file';
  }

  // --- Projects -------------------------------------------------------------
  protected async create(): Promise<void> {
    if (this.config.collection === 'slideshows') {
      this.slideItems.set([]);
      this.creating.set(true);
      return;
    }
    const title = await this.ui.prompt('Movie title', '', 'Create');
    if (title)
      await this.attempt(async () =>
        this.open((await this.store.create({ title, clips: [createScene()] })).id),
      );
  }

  protected async chooseSlides(): Promise<void> {
    const items = await this.ui.pickMedia(['image', 'video'], true);
    this.slideItems.update((list) => [...list, ...items]);
  }

  protected addFolder(select: HTMLSelectElement): void {
    const folderId = select.value === 'root' ? null : select.value;
    const items = this.library
      .items()
      .filter((m) => m.folderId === folderId && (m.kind === 'image' || m.kind === 'video'));
    if (!items.length) this.ui.toast('That folder has no pictures or videos');
    this.slideItems.update((list) => [...list, ...items.reverse()]);
    select.value = '';
  }

  protected dropSlide(event: CdkDragDrop<unknown>): void {
    this.slideItems.update((list) => moveItem(list, event.previousIndex, event.currentIndex));
  }

  protected removeSlide(index: number): void {
    this.slideItems.update((list) => list.filter((_, i) => i !== index));
  }

  private async durationOf(mediaId: string): Promise<number> {
    return (await this.api.get<{ duration: number }>(`/video/probe/${mediaId}`)).duration;
  }

  protected async buildShow(event: Event): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    const title = String(form.get('title') ?? '').trim();
    const items = this.slideItems();
    if (!title || !items.length) return;
    await this.attempt(async () => {
      const sources: SlideSource[] = [];
      for (const item of items) {
        sources.push({
          id: item.id,
          kind: item.kind as 'image' | 'video',
          duration: item.kind === 'video' ? await this.durationOf(item.id) : undefined,
        });
      }
      const seconds = clamp(Number(form.get('seconds')) || 4, 1, 60);
      const created = await this.store.create({
        title,
        aspect: String(form.get('aspect')) as Aspect,
        clips: buildSlideshow(sources, seconds, String(form.get('transition')) as Transition),
      });
      this.creating.set(false);
      this.open(created.id);
    });
  }

  protected open(id: string): void {
    const movie = this.store.byId(id);
    if (!movie) return;
    this.history.reset({ ...emptyData(), ...dataOf(movie) });
    this.openId.set(id);
    this.lastExport.set(null);
    this.select(this.data().clips[0]?.id ?? null);
    this.engine.time.set(0);
  }

  protected async close(): Promise<void> {
    this.engine.pause();
    this.cancelExport();
    await this.store.flushAll();
    this.openId.set(null);
    this.history.reset(emptyData());
  }

  protected async rename(movie: Movie): Promise<void> {
    const title = await this.ui.prompt('Title', movie.title);
    if (title) this.store.patch(movie.id, { title } as Partial<Movie>, 0);
  }

  protected async remove(movie: Movie): Promise<void> {
    if (
      await this.ui.confirm(`Delete “${movie.title}”?`, 'Files in your library are not affected.')
    ) {
      await this.attempt(() => this.store.remove(movie.id));
    }
  }

  // --- Editing --------------------------------------------------------------
  private persist(): void {
    const id = this.openId();
    if (id) this.store.patch(id, this.history.value as Partial<Movie>, 800);
  }

  protected set(patch: Partial<Data>, key = ''): void {
    this.history.commit({ ...this.history.value, ...patch }, key);
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

  protected setBand(which: 'header' | 'footer', patch: Partial<MovieBand>): void {
    this.set(
      { [which]: { ...this.data()[which], ...patch } },
      `${which}:${Object.keys(patch).join()}`,
    );
  }

  protected select(sceneId: string | null): void {
    this.sceneId.set(sceneId);
    this.objectId.set(null);
    this.bubbleId.set(null);
  }

  protected jump(scene: Scene, index: number): void {
    this.engine.pause();
    this.select(scene.id);
    this.engine.seek(sceneOffset(this.data().clips, index) + 0.001);
  }

  private editScene(change: (scene: Scene) => Scene, key = '', id = this.sceneId()): void {
    this.set(
      { clips: this.data().clips.map((s) => (s.id === id ? change(s) : s)) },
      key && `${id}:${key}`,
    );
  }

  protected patchScene(patch: Partial<Scene>): void {
    this.editScene((s) => ({ ...s, ...patch }), Object.keys(patch).join());
  }

  protected duration(seconds: number): void {
    this.editScene((s) => setDuration(s, seconds), 'duration');
  }

  protected addScene(): void {
    const scene = createScene();
    const clips = [...this.data().clips];
    const at = clips.findIndex((s) => s.id === this.sceneId());
    clips.splice(at < 0 ? clips.length : at + 1, 0, scene);
    this.set({ clips });
    this.jump(scene, clips.indexOf(scene));
  }

  protected duplicateScene(): void {
    const source = this.scene();
    if (!source) return;
    const copy: Scene = structuredClone(source);
    copy.id = uid();
    const renamed = new Map<string, string>();
    copy.objects.forEach((o) => {
      const id = uid();
      renamed.set(o.id, id);
      o.id = id;
    });
    copy.bubbles.forEach((b) => {
      b.id = uid();
      if (b.objectId) b.objectId = renamed.get(b.objectId) ?? null;
    });
    const clips = [...this.data().clips];
    clips.splice(clips.findIndex((s) => s.id === source.id) + 1, 0, copy);
    this.set({ clips });
    this.jump(copy, clips.indexOf(copy));
  }

  protected removeScene(): void {
    const index = this.data().clips.findIndex((s) => s.id === this.sceneId());
    const clips = this.data().clips.filter((s) => s.id !== this.sceneId());
    this.set({ clips });
    this.select(clips[Math.min(index, clips.length - 1)]?.id ?? null);
  }

  protected dropScene(event: CdkDragDrop<unknown>): void {
    if (event.previousIndex !== event.currentIndex)
      this.set({ clips: moveItem(this.data().clips, event.previousIndex, event.currentIndex) });
  }

  protected async addMedia(): Promise<void> {
    const sceneId = this.sceneId();
    if (!sceneId) return;
    const items = await this.ui.pickMedia(['image', 'video'], true);
    if (!items.length) return;
    this.editScene(
      (s) => ({
        ...s,
        objects: [
          ...s.objects,
          ...items.map((m, i) => {
            const count = s.objects.length + i;
            return createObject(m.kind as 'image' | 'video', m.id, s.duration, {
              x: 0.5 + (count % 3) * 0.12,
              y: 0.55,
              width: 0.45,
            });
          }),
        ],
      }),
      '',
      sceneId,
    );
  }

  protected patchObject(patch: Partial<SceneObject>): void {
    const id = this.objectId();
    this.editScene(
      (s) => ({ ...s, objects: s.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)) }),
      `${id}:${Object.keys(patch).join()}`,
    );
  }

  protected removeObject(): void {
    const id = this.objectId();
    this.editScene((s) => ({
      ...s,
      objects: s.objects.filter((o) => o.id !== id),
      bubbles: s.bubbles.map((b) => (b.objectId === id ? { ...b, objectId: null } : b)),
    }));
    this.objectId.set(null);
  }

  protected layerObject(by: number): void {
    const id = this.objectId();
    this.editScene((s) => {
      const from = s.objects.findIndex((o) => o.id === id);
      return { ...s, objects: moveItem(s.objects, from, from + by) };
    });
  }

  protected addBubble(): void {
    const scene = this.scene();
    if (!scene) return;
    const bubble = createBubble(scene.duration, { objectId: this.objectId() });
    this.editScene((s) => ({ ...s, bubbles: [...s.bubbles, bubble] }));
    this.bubbleId.set(bubble.id);
    this.objectId.set(null);
  }

  protected pinBubble(edge: 'top' | 'bottom'): void {
    this.patchBubble({ objectId: null, x: 0.5, y: edge === 'top' ? 0.08 : 0.92 });
  }

  protected duplicateBubble(): void {
    const source = this.bubble();
    if (!source) return;
    const copy: Bubble = { ...source, id: uid(), y: clamp(source.y - 0.12, 0, 1) };
    this.editScene((s) => ({ ...s, bubbles: [...s.bubbles, copy] }));
    this.bubbleId.set(copy.id);
  }

  /** Library id of the picture being edited in the built-in image editor. */
  protected readonly editingImage = signal<{
    sceneId: string;
    objectId: string;
    mediaId: string;
  } | null>(null);

  private swapMedia(sceneId: string, objectId: string, media: MediaItem): void {
    this.editScene(
      (s) => ({
        ...s,
        objects: s.objects.map((o) =>
          o.id === objectId
            ? { ...o, mediaId: media.id, kind: media.kind as 'image' | 'video', trimStart: 0 }
            : o,
        ),
      }),
      '',
      sceneId,
    );
  }

  protected async replaceMedia(): Promise<void> {
    const sceneId = this.sceneId();
    const objectId = this.objectId();
    const movieId = this.openId();
    const [media] = await this.ui.pickMedia(['image', 'video']);
    if (media && sceneId && objectId && this.openId() === movieId)
      this.swapMedia(sceneId, objectId, media);
  }

  protected editImage(object: SceneObject): void {
    this.engine.pause();
    this.editingImage.set({
      sceneId: this.sceneId()!,
      objectId: object.id,
      mediaId: object.mediaId,
    });
  }

  /** The editor saved a new picture: use it in place of the old one. The original file is kept. */
  protected imageEdited(media: MediaItem): void {
    const target = this.editingImage();
    this.editingImage.set(null);
    if (target) this.swapMedia(target.sceneId, target.objectId, media);
  }

  protected patchBubble(patch: Partial<Bubble>): void {
    const id = this.bubbleId();
    this.editScene(
      (s) => ({ ...s, bubbles: s.bubbles.map((b) => (b.id === id ? { ...b, ...patch } : b)) }),
      `${id}:${Object.keys(patch).join()}`,
    );
  }

  protected removeBubble(): void {
    const id = this.bubbleId();
    this.editScene((s) => ({ ...s, bubbles: s.bubbles.filter((b) => b.id !== id) }));
    this.bubbleId.set(null);
  }

  protected async chooseMusic(): Promise<void> {
    const [item] = await this.ui.pickMedia(['audio', 'video']);
    if (item) this.set({ musicMediaId: item.id });
  }

  /** Click to select an object on the canvas; drag to move it. */
  protected pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.engine.playing()) return;
    const canvas = this.canvas()!.nativeElement;
    const box = canvas.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * canvas.width;
    const y = ((event.clientY - box.top) / box.height) * canvas.height;
    const hit = [...this.engine.placed]
      .reverse()
      .find((p) => Math.abs(x - p.x) <= p.w / 2 && Math.abs(y - p.y) <= p.h / 2);
    const at = sceneAt(this.data().clips, this.engine.time());
    if (!hit || !at) return;
    event.preventDefault();
    this.select(this.data().clips[at.index]!.id);
    this.objectId.set(hit.object.id);
    if (hit.object.fit !== 'free') return;
    const original = this.history.value;
    const data = this.data();
    const headerHeight = data.header.enabled ? movieBand(data.header).size : 0;
    const footerHeight = data.footer.enabled ? movieBand(data.footer).size : 0;
    const areaHeight = canvas.height - headerHeight - footerHeight;
    const sceneId = this.sceneId();
    trackPointer(
      event,
      ({ dx, dy }) => {
        const nx = clamp(hit.object.x + dx / box.width, 0, 1);
        const ny = clamp(hit.object.y + (dy / box.height) * (canvas.height / areaHeight), 0, 1);
        this.history.preview({
          ...original,
          clips: original.clips.map((s) =>
            s.id !== sceneId
              ? s
              : {
                  ...s,
                  objects: s.objects.map((o) =>
                    o.id === hit.object.id ? { ...o, x: nx, y: ny } : o,
                  ),
                },
          ),
        });
      },
      ({ moved, cancelled }) => {
        if (cancelled || !moved) this.history.cancelPreview();
        else {
          this.history.commitPreview();
          this.persist();
        }
      },
    );
  }

  // --- Export ---------------------------------------------------------------
  protected async export(format: 'webm' | 'mp4'): Promise<void> {
    const movie = this.movie();
    if (!movie || this.exportState()) return;
    if (!this.data().clips.some((s) => s.objects.length || s.bubbles.length)) {
      this.ui.toast('Add pictures, videos or text to a scene first', 'error');
      return;
    }
    this.engine.pause();
    this.cancelled = false;
    this.lastExport.set(null);
    this.exportState.set({ label: 'Recording in real time. Keep this tab open', progress: 0 });
    const title = safeFilename(movie.title);
    try {
      this.recording = recordMovie(this.data(), (progress) =>
        this.exportState.update((s) => s && { ...s, progress }),
      );
      const blob = await this.recording.result;
      if (!blob || this.cancelled) return;
      let saved = await this.library.upload(blob, `${title}.webm`);
      if (format === 'mp4') saved = await this.convert(saved, title);
      this.lastExport.set(saved.id);
      this.ui.success('Saved to your library');
    } catch (error) {
      if (!this.cancelled) {
        this.ui.error(error);
      }
    } finally {
      this.recording = null;
      this.exportState.set(null);
    }
  }

  /** Converts the recording to MP4 with the server's FFmpeg, then removes the temporary WebM. */
  private async convert(source: MediaItem, title: string): Promise<MediaItem> {
    const size = ASPECTS[this.data().aspect];
    const duration = await this.durationOf(source.id);
    const form = new FormData();
    form.append(
      'spec',
      JSON.stringify({
        title,
        format: 'mp4',
        width: size.width,
        height: size.height,
        clips: [{ mediaId: source.id, start: 0, end: duration }],
      }),
    );
    let job = await this.api.post<{
      id: string;
      status: string;
      progress: number;
      error: string | null;
      mediaId: string | null;
    }>('/video/jobs', form);
    while (job.status === 'queued' || job.status === 'running') {
      if (this.cancelled || this.destroyed) {
        await this.api.delete(`/video/jobs/${job.id}`);
        return source;
      }
      this.exportState.set({ label: 'Converting to MP4', progress: job.progress });
      await new Promise((resolve) => setTimeout(resolve, 600));
      job = await this.api.get(`/video/jobs/${job.id}`);
    }
    if (job.status !== 'done')
      throw new Error(job.error ?? 'MP4 conversion failed. The WebM version is in your library.');
    await this.library.refresh();
    await this.library.remove(source.id);
    return this.library.byId(job.mediaId)!;
  }

  protected cancelExport(): void {
    if (!this.exportState()) return;
    this.cancelled = true;
    this.recording?.cancel();
  }

  protected downloadUrl(id: string): string {
    return `${mediaUrl(id)}?download=1`;
  }

  protected exportProject(): void {
    const movie = this.movie()!;
    downloadBlob(
      new Blob([JSON.stringify(this.data(), null, 2)], { type: 'application/json' }),
      `${movie.title}.movie.json`,
    );
  }

  protected keys(event: KeyboardEvent): void {
    if (!this.openId() || isTyping(event) || this.exportState() || this.editingImage()) return;
    if (handleHistoryKey(event, this.history as History<unknown>)) {
      this.persist();
      return;
    }
    if (event.key === ' ' && (event.target as HTMLElement).tagName !== 'BUTTON') {
      event.preventDefault();
      if (this.engine.playing()) this.engine.pause();
      else this.engine.play();
    } else if (event.key === 'Delete') {
      if (this.objectId()) this.removeObject();
      else if (this.bubbleId()) this.removeBubble();
    }
  }
}
