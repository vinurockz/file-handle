import { CdkDrag, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import {
  Component,
  computed,
  DestroyRef,
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
import { Api } from '../../core/api';
import { injectCollection } from '../../core/collection';
import { handleHistoryKey, History } from '../../core/history';
import { MediaLibrary, mediaUrl, type MediaItem } from '../../core/media';
import { ProjectSaver, type Project } from '../../core/project';
import { Ui } from '../../core/ui';
import {
  canvasBlob,
  clamp,
  formatTime,
  isTyping,
  moveItem,
  pickFiles,
  safeFilename,
  uid,
} from '../../core/util';
import { Slider } from '../../shared/widgets';
import { FONTS } from '../image/model';
import { Player } from './player';
import {
  clipLength,
  createClip,
  drawOverlay,
  emptyVideoDoc,
  FRAME_SIZES,
  offsetOf,
  splitAt,
  toSpec,
  totalLength,
  trim,
  type Clip,
  type Overlay,
  type VideoDoc,
} from './timeline';

export interface Job {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  error: string | null;
  mediaId: string | null;
}

@Component({
  selector: 'app-video-editor',
  imports: [Slider, CdkDrag, CdkDropList],
  host: { '(document:keydown)': 'keys($event)' },
  templateUrl: './video-editor.html',
  styleUrl: './video-editor.scss',
})
export class VideoEditor implements OnInit {
  readonly media = input<string>();

  private readonly api = inject(Api);
  protected readonly library = inject(MediaLibrary);
  private readonly ui = inject(Ui);
  private readonly router = inject(Router);
  protected readonly projects = injectCollection<Project<VideoDoc>>('videoProjects');
  private readonly saver = new ProjectSaver<VideoDoc>(this.projects, (e) => this.ui.error(e));
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  protected readonly history = new History<VideoDoc>(emptyVideoDoc());
  protected readonly opened = signal<{ name: string; mediaId: string | null } | null>(null);
  protected readonly clipId = signal<string | null>(null);
  protected readonly overlayId = signal<string | null>(null);
  protected readonly job = signal<Job | null>(null);
  protected readonly submitting = signal(false);
  protected readonly adding = signal(false);

  protected readonly doc = computed(() => this.history.value);
  protected readonly player = new Player(() => untracked(this.doc));
  protected readonly total = computed(() => totalLength(this.doc().clips));
  protected readonly clip = computed(
    () => this.doc().clips.find((c) => c.id === this.clipId()) ?? null,
  );
  protected readonly overlay = computed(
    () => this.doc().overlays.find((o) => o.id === this.overlayId()) ?? null,
  );
  protected readonly videos = computed(() =>
    this.library.items().filter((m) => m.kind === 'video'),
  );
  protected readonly saved = computed(() =>
    [...this.projects.items()].sort((a, b) => b.updatedAt - a.updatedAt),
  );
  protected readonly exporting = computed(
    () => this.submitting() || ['queued', 'running'].includes(this.job()?.status ?? ''),
  );
  protected readonly previewSize = computed(() => {
    const { width, height } = this.doc();
    const scale = Math.min(1, 960 / Math.max(width, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  });

  protected readonly frameSizes = FRAME_SIZES;
  protected readonly fonts = FONTS;
  protected readonly speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  protected readonly sides = ['top', 'right', 'bottom', 'left'] as const;
  protected readonly time = formatTime;
  protected readonly length = clipLength;
  protected readonly round = Math.round;

  private savedRevision = 0;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  constructor() {
    effect(() => {
      const element = this.canvas()?.nativeElement ?? null;
      this.previewSize();
      // Wait for the canvas size bindings to apply, as resizing clears it.
      queueMicrotask(() => this.player.attach(element));
    });
    effect(() => {
      this.doc();
      untracked(() => {
        if (this.player.time() > this.total()) this.player.seek(this.total());
        else this.player.sync(!this.player.playing());
      });
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
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      clearTimeout(this.poll);
      this.player.destroy();
    });
  }

  async ngOnInit(): Promise<void> {
    await Promise.all([this.library.load(), this.projects.load()]);
    const item = this.library.byId(this.media());
    if (item?.kind === 'video') await this.openVideo(item);
  }

  protected name(mediaId: string): string {
    return this.library.byId(mediaId)?.title ?? 'Missing file';
  }

  protected thumbUrl(clip: Clip): string {
    return clip.kind === 'video'
      ? `${mediaUrl(clip.mediaId)}#t=${(clip.start + 0.1).toFixed(1)}`
      : mediaUrl(clip.mediaId);
  }

  private async makeClip(item: MediaItem): Promise<Clip> {
    if (item.kind === 'image') return createClip(item.id, 'image', 0);
    const probe = await this.api.get<{
      duration: number;
      hasVideo: boolean;
      width: number;
      height: number;
    }>(`/video/probe/${item.id}`);
    if (!probe.hasVideo || !(probe.duration >= 0.1))
      throw new Error(`“${item.title}” has no playable video`);
    return createClip(item.id, 'video', Math.floor(probe.duration * 1000) / 1000);
  }

  // --- Opening --------------------------------------------------------------
  private show(
    name: string,
    mediaId: string | null,
    doc: VideoDoc,
    projectId: string | null,
  ): void {
    this.player.pause();
    this.saver.open(projectId);
    this.history.reset(doc);
    this.savedRevision = 0;
    this.clipId.set(doc.clips[0]?.id ?? null);
    this.overlayId.set(null);
    this.job.set(null);
    this.opened.set({ name, mediaId });
    this.player.seek(0);
  }

  protected async openVideo(item: MediaItem): Promise<void> {
    const project = this.saved().find((p) => p.mediaId === item.id);
    if (project) {
      this.resume(project);
      return;
    }
    try {
      const clip = await this.makeClip(item);
      this.show(item.title, item.id, { ...emptyVideoDoc(), clips: [clip] }, null);
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected resume(project: Project<VideoDoc>): void {
    this.show(project.name, project.mediaId, { ...emptyVideoDoc(), ...project.doc }, project.id);
  }

  protected async uploadVideo(): Promise<void> {
    const [file] = await pickFiles('video/*,.mkv,.avi,.mov', false);
    if (!file) return;
    try {
      const item = await this.library.upload(file, file.name);
      if (item.kind === 'video') await this.openVideo(item);
      else this.ui.toast('That file is not a video', 'error');
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected newProject(): void {
    const doc = emptyVideoDoc();
    this.show('New video', null, doc, null);
    this.saver.save({ name: 'New video', mediaId: null, doc });
  }

  protected async close(): Promise<void> {
    this.player.pause();
    clearTimeout(this.poll);
    await this.saver.flush();
    this.saver.open(null);
    this.opened.set(null);
    this.history.reset(emptyVideoDoc());
    this.savedRevision = 0;
    if (this.media()) await this.router.navigate(['/video-editor']);
  }

  protected async rename(): Promise<void> {
    const opened = this.opened()!;
    const name = await this.ui.prompt('Name this video', opened.name);
    if (!name) return;
    this.opened.set({ ...opened, name });
    this.saver.save({ name, mediaId: opened.mediaId, doc: this.history.value });
  }

  protected async deleteProject(project: Project<VideoDoc>): Promise<void> {
    if (!(await this.ui.confirm(`Delete the saved edit “${project.name}”?`))) return;
    try {
      await this.projects.remove(project.id);
    } catch (error) {
      this.ui.error(error);
    }
  }

  // --- Editing --------------------------------------------------------------
  protected set(patch: Partial<VideoDoc>, key = ''): void {
    this.history.commit({ ...this.history.value, ...patch }, key);
  }

  protected editClip(patch: Partial<Clip>, key = Object.keys(patch).join()): void {
    const id = this.clipId();
    this.set(
      { clips: this.doc().clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) },
      `${id}:${key}`,
    );
  }

  protected setTrim(side: 'start' | 'end', value: number): void {
    const clip = this.clip();
    if (!clip) return;
    const next = trim(
      clip,
      side === 'start' ? value : clip.start,
      side === 'end' ? value : clip.end,
    );
    this.editClip({ start: next.start, end: next.end }, `trim-${side}`);
    // Show the frame being trimmed to.
    const index = this.doc().clips.findIndex((c) => c.id === clip.id);
    this.player.seek(
      offsetOf(this.doc().clips, index) +
        (side === 'start' ? 0 : Math.max(0, clipLength(next) - 0.05)),
    );
  }

  protected setCut(side: keyof Clip['cut'], value: number): void {
    const cut = this.clip()!.cut;
    const opposite = ({ top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const)[
      side
    ];
    this.editClip({ cut: { ...cut, [side]: clamp(value, 0, 90 - cut[opposite]) } }, `cut-${side}`);
  }

  protected trimHere(side: 'start' | 'end'): void {
    const clip = this.clip();
    if (!clip) return;
    const index = this.doc().clips.findIndex((c) => c.id === clip.id);
    const into = this.player.time() - offsetOf(this.doc().clips, index);
    if (into <= 0 || into >= clipLength(clip)) {
      this.ui.toast('Move the playhead inside the selected clip first');
      return;
    }
    this.setTrim(side, clip.start + into * clip.speed);
  }

  protected split(): void {
    const clips = splitAt(this.doc().clips, this.player.time());
    if (clips === this.doc().clips)
      this.ui.toast('Move the playhead away from the clip edges to split');
    else this.set({ clips });
  }

  protected async addClips(): Promise<void> {
    const items = await this.ui.pickMedia(['video', 'image'], true);
    if (!items.length) return;
    const opened = this.opened();
    this.adding.set(true);
    for (const item of items) {
      try {
        const clip = await this.makeClip(item);
        if (this.opened() !== opened) break;
        if (this.doc().clips.length >= 50) throw new Error('A video can have at most 50 clips');
        this.set({ clips: [...this.doc().clips, clip] });
        this.clipId.set(clip.id);
      } catch (error) {
        this.ui.error(error);
      }
    }
    this.adding.set(false);
  }

  protected selectClip(clip: Clip, index: number): void {
    this.clipId.set(clip.id);
    this.overlayId.set(null);
    this.player.pause();
    this.player.seek(offsetOf(this.doc().clips, index) + 0.001);
  }

  protected dropClip(event: CdkDragDrop<unknown>): void {
    if (event.previousIndex !== event.currentIndex) {
      this.set({ clips: moveItem(this.doc().clips, event.previousIndex, event.currentIndex) });
    }
  }

  protected shiftClip(by: number): void {
    const from = this.doc().clips.findIndex((c) => c.id === this.clipId());
    if (from >= 0) this.set({ clips: moveItem(this.doc().clips, from, from + by) });
  }

  protected duplicateClip(): void {
    const clip = this.clip();
    if (!clip) return;
    const clips = [...this.doc().clips];
    const copy = { ...structuredClone(clip), id: uid() };
    clips.splice(clips.indexOf(clip) + 1, 0, copy);
    this.set({ clips });
    this.clipId.set(copy.id);
  }

  protected removeClip(): void {
    this.set({ clips: this.doc().clips.filter((c) => c.id !== this.clipId()) });
    this.clipId.set(this.doc().clips[0]?.id ?? null);
  }

  protected addOverlay(sticker = false, place: 'top' | 'bottom' = 'bottom'): void {
    const start = Math.min(this.player.time(), Math.max(0, this.total() - 0.5));
    const overlay: Overlay = {
      id: uid(),
      text: sticker ? '🔥' : `${place === 'top' ? 'TOP' : 'BOTTOM'} TEXT`,
      start,
      end: Math.max(start + 0.5, Math.min(this.total(), start + 3)),
      x: sticker ? 0.88 : 0.5,
      y: sticker ? 0.84 : place === 'top' ? 0.12 : 0.85,
      size: sticker ? 0.14 : 0.07,
      color: '#ffffff',
      outline: sticker ? '' : '#000000',
      background: '',
      fontFamily: FONTS[1]!.value,
    };
    this.set({ overlays: [...this.doc().overlays, overlay] });
    this.overlayId.set(overlay.id);
  }

  protected editOverlay(patch: Partial<Overlay>): void {
    const id = this.overlayId();
    this.set(
      {
        overlays: this.doc().overlays.map((o) => {
          if (o.id !== id) return o;
          const next = { ...o, ...patch };
          if (next.end < next.start + 0.1) next.end = next.start + 0.1;
          return next;
        }),
      },
      `${id}:${Object.keys(patch).join()}`,
    );
  }

  protected removeOverlay(): void {
    this.set({ overlays: this.doc().overlays.filter((o) => o.id !== this.overlayId()) });
    this.overlayId.set(null);
  }

  protected async chooseMusic(): Promise<void> {
    const [item] = await this.ui.pickMedia(['audio', 'video']);
    if (item) this.set({ music: { mediaId: item.id, volume: this.doc().music?.volume ?? 0.6 } });
  }

  protected setSize(index: number): void {
    const size = FRAME_SIZES[index];
    if (size) this.set({ width: size.width, height: size.height });
  }

  protected async snapshot(): Promise<void> {
    const canvas = this.canvas()?.nativeElement;
    if (!canvas) return;
    this.player.pause();
    try {
      await this.library.upload(
        await canvasBlob(canvas),
        `${safeFilename(this.opened()!.name)} frame.png`,
      );
      this.ui.success('Current frame saved to your library');
    } catch (error) {
      this.ui.error(error);
    }
  }

  // --- Export ---------------------------------------------------------------
  protected async export(): Promise<void> {
    if (this.exporting() || !this.doc().clips.length) return;
    this.player.pause();
    this.submitting.set(true);
    this.exportedRevision = this.history.revision();
    try {
      const { spec, overlays } = toSpec(this.doc(), `${this.opened()!.name} (edited)`);
      const form = new FormData();
      form.append('spec', JSON.stringify(spec));
      for (const [index, overlay] of (spec.overlays.length ? overlays : []).entries()) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(spec.width / 2) * 2;
        canvas.height = Math.round(spec.height / 2) * 2;
        drawOverlay(canvas.getContext('2d')!, overlay, canvas.width, canvas.height);
        form.append('overlays', await canvasBlob(canvas), `overlay-${index}.png`);
      }
      const job = await this.api.post<Job>('/video/jobs', form);
      this.job.set(job);
      this.watch(job.id);
    } catch (error) {
      this.ui.error(error);
    } finally {
      this.submitting.set(false);
    }
  }

  private exportedRevision = -1;

  /** The edit is done only if nothing changed since the export started. */
  private markDone(): void {
    const opened = this.opened();
    if (opened && this.history.revision() === this.exportedRevision) {
      this.saver.save({
        name: opened.name,
        mediaId: opened.mediaId,
        doc: this.history.value,
        status: 'done',
      });
    }
  }

  private watch(id: string, failures = 0): void {
    clearTimeout(this.poll);
    this.poll = setTimeout(async () => {
      try {
        const job = await this.api.get<Job>(`/video/jobs/${id}`);
        if (this.destroyed || this.job()?.id !== id) return;
        this.job.set(job);
        if (job.status === 'queued' || job.status === 'running') this.watch(id);
        else if (job.status === 'done') {
          await this.library.refresh();
          this.markDone();
          this.ui.success('Export finished. The new file is in your library.');
        }
      } catch (error) {
        // A brief network problem should not abandon a running export.
        if (this.destroyed || this.job()?.id !== id) return;
        if (failures < 4) this.watch(id, failures + 1);
        else {
          this.job.set(null);
          this.ui.error(error);
        }
      }
    }, 700);
  }

  protected async cancelExport(): Promise<void> {
    const job = this.job();
    if (!job) return;
    clearTimeout(this.poll);
    try {
      await this.api.delete(`/video/jobs/${job.id}`);
      this.job.set({ ...job, status: 'cancelled' });
    } catch (error) {
      this.ui.error(error);
      this.watch(job.id);
    }
  }

  protected resultUrl(id: string): string {
    return `${mediaUrl(id)}?download=1`;
  }

  protected keys(event: KeyboardEvent): void {
    if (!this.opened() || isTyping(event)) return;
    if (handleHistoryKey(event, this.history as History<unknown>)) return;
    const frame = 1 / this.doc().fps;
    if (event.key === ' ' && (event.target as HTMLElement).tagName !== 'BUTTON')
      this.player.toggle();
    else if (event.key === 'ArrowLeft')
      this.player.seek(this.player.time() - (event.shiftKey ? 1 : frame));
    else if (event.key === 'ArrowRight')
      this.player.seek(this.player.time() + (event.shiftKey ? 1 : frame));
    else if (event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey) this.split();
    else return;
    event.preventDefault();
  }
}
