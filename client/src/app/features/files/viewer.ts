import {
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { mediaUrl, type MediaItem } from '../../core/media';
import { formatBytes } from '../../core/util';
import { Modal } from '../../shared/widgets';

const EDITORS: Partial<Record<MediaItem['kind'], { path: string; label: string }>> = {
  image: { path: '/image-editor', label: 'Edit image' },
  video: { path: '/video-editor', label: 'Edit video' },
  pdf: { path: '/pdf', label: 'Edit PDF' },
};

/** Full-size viewer with previous/next, slideshow, full screen, picture-in-picture and skipping. */
@Component({
  selector: 'app-viewer',
  imports: [Modal, RouterLink],
  template: `
    <app-modal
      [heading]="item().title"
      [wide]="true"
      (closed)="closed.emit()"
      (keyed)="keys($event)"
    >
      <div #stage class="viewer-stage" tabindex="-1">
        @switch (item().kind) {
          @case ('image') {
            <img [src]="url()" [alt]="item().title" />
          }
          @case ('video') {
            <video #video [src]="url()" controls autoplay playsinline></video>
          }
          @case ('audio') {
            <audio #video [src]="url()" controls autoplay></audio>
          }
          @case ('pdf') {
            <p class="empty">📄 Open this PDF in the editor to read and mark it up.</p>
          }
        }
      </div>
      <div class="row wrap">
        <button type="button" class="btn" [disabled]="items().length < 2" (click)="step(-1)">
          ← Previous
        </button>
        <button type="button" class="btn" [disabled]="items().length < 2" (click)="step(1)">
          Next →
        </button>
        @if (item().kind === 'image') {
          <button type="button" class="btn" [class.active]="playing()" (click)="slideshow()">
            {{ playing() ? 'Pause slideshow' : 'Slideshow' }}
          </button>
        }
        @if (item().kind === 'video' || item().kind === 'audio') {
          @for (skip of skips; track skip) {
            <button type="button" class="btn small" (click)="skipBy(skip)">
              {{ skip > 0 ? '+' : '' }}{{ skip }}s
            </button>
          }
        }
        @if (item().kind === 'video' && pipSupported) {
          <button type="button" class="btn" (click)="pip()">Picture in picture</button>
        }
        @if (item().kind === 'image' || item().kind === 'video') {
          <button type="button" class="btn" (click)="fullscreen()">Full screen</button>
        }
        <span class="grow muted">{{ size() }}</span>
        <a class="btn" [href]="url() + '?download=1'" download>Download</a>
        @if (editor(); as target) {
          <a
            class="btn primary"
            [routerLink]="target.path"
            [queryParams]="{ media: item().id }"
            (click)="closed.emit()"
          >
            {{ target.label }}
          </a>
        }
      </div>
    </app-modal>
  `,
  styles: `
    .viewer-stage {
      display: grid;
      place-items: center;
      background: #0d0f1a;
      border-radius: 8px;
      min-height: 120px;
    }
    .viewer-stage img,
    .viewer-stage video {
      max-height: 62vh;
      max-width: 100%;
      object-fit: contain;
    }
    .viewer-stage .empty {
      color: #fff;
    }
  `,
})
export class Viewer {
  readonly items = input.required<MediaItem[]>();
  readonly startId = input.required<string>();
  readonly closed = output<void>();
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly stage = viewChild.required<ElementRef<HTMLElement>>('stage');
  private readonly chosen = signal<string | null>(null);
  protected readonly item = computed(
    () => this.items().find((m) => m.id === (this.chosen() ?? this.startId())) ?? this.items()[0]!,
  );
  protected readonly url = computed(() => mediaUrl(this.item().id));
  protected readonly size = computed(() => formatBytes(this.item().size));
  protected readonly editor = computed(() => EDITORS[this.item().kind]);
  protected readonly playing = signal(false);
  protected readonly skips = [-30, -10, 10, 30];
  protected readonly pipSupported = document.pictureInPictureEnabled;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearInterval(this.timer));
  }

  protected step(by: number): void {
    const list = this.items();
    const index = list.findIndex((m) => m.id === this.item().id);
    this.chosen.set(list[(index + by + list.length) % list.length]!.id);
  }

  protected keys(event: KeyboardEvent): void {
    if (
      event.defaultPrevented ||
      ['VIDEO', 'AUDIO'].includes((event.target as HTMLElement).tagName)
    )
      return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    this.step(event.key === 'ArrowRight' ? 1 : -1);
  }

  protected slideshow(): void {
    clearInterval(this.timer);
    this.playing.update((v) => !v);
    if (!this.playing()) return;
    this.timer = setInterval(() => {
      const images = this.items().filter((m) => m.kind === 'image');
      const index = images.findIndex((m) => m.id === this.item().id);
      this.chosen.set(images[(index + 1) % images.length]!.id);
    }, 4000);
  }

  protected skipBy(seconds: number): void {
    const element = this.video()?.nativeElement;
    if (!element) return;
    const end = Number.isFinite(element.duration) ? element.duration : Number.MAX_SAFE_INTEGER;
    element.currentTime = Math.min(end, Math.max(0, element.currentTime + seconds));
  }

  protected pip(): void {
    this.video()
      ?.nativeElement.requestPictureInPicture()
      .catch(() => undefined);
  }

  protected fullscreen(): void {
    const stage = this.stage().nativeElement;
    stage
      .requestFullscreen()
      .then(() => stage.focus())
      .catch(() => undefined);
  }
}
