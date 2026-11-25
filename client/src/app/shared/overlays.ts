import { Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import { MediaLibrary, mediaUrl, type MediaItem, type MediaKind } from '../core/media';
import { Ui, type DialogRequest } from '../core/ui';
import { formatBytes, pickFiles } from '../core/util';
import { ContextMenu } from './context-menu';
import { Modal } from './widgets';

export const KIND_ICON: Record<MediaKind, string> = {
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
  pdf: '📄',
};
const ACCEPT: Record<MediaKind, string> = {
  image: 'image/*',
  video: 'video/*,.mkv,.avi,.mov',
  audio: 'audio/*',
  pdf: 'application/pdf',
};

@Component({
  selector: 'app-thumb',
  template: `
    @let media = item();
    @if (media.kind === 'image') {
      <img [src]="url()" [alt]="media.title" loading="lazy" draggable="false" />
    } @else if (media.kind === 'video') {
      <video [src]="url() + '#t=0.1'" preload="metadata" muted playsinline></video>
      <span class="thumb-badge" aria-hidden="true">▶</span>
    } @else {
      <span class="thumb-icon" aria-hidden="true">{{ icons[media.kind] }}</span>
    }
  `,
  host: { class: 'thumb' },
})
export class Thumb {
  readonly item = input.required<MediaItem>();
  protected readonly icons = KIND_ICON;
  protected readonly url = computed(() => mediaUrl(this.item().id));
}

@Component({
  selector: 'app-media-picker',
  imports: [Modal, Thumb],
  template: `
    <app-modal heading="Choose from library" [wide]="true" (closed)="done.emit([])">
      <div class="row wrap">
        <input
          class="grow"
          type="search"
          aria-label="Search files"
          placeholder="Search files"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
        <button type="button" class="btn" [disabled]="library.uploading() > 0" (click)="upload()">
          {{ library.uploading() ? 'Uploading…' : 'Upload from device' }}
        </button>
      </div>
      @if (!library.loaded()) {
        <p class="empty">Loading…</p>
      } @else if (!visible().length) {
        <p class="empty">No matching files yet. Upload one to continue.</p>
      } @else {
        <div class="media-grid">
          @for (item of visible(); track item.id) {
            <button
              type="button"
              class="media-card"
              [class.selected]="selected().includes(item.id)"
              [attr.aria-pressed]="selected().includes(item.id)"
              (click)="toggle(item)"
            >
              <app-thumb [item]="item" />
              <span class="media-title">{{ item.title }}</span>
              <small>{{ bytes(item.size) }}</small>
            </button>
          }
        </div>
      }
      @if (multiple()) {
        <footer class="row end">
          <button type="button" class="btn" (click)="done.emit([])">Cancel</button>
          <button
            type="button"
            class="btn primary"
            [disabled]="!selected().length"
            (click)="confirm()"
          >
            Add {{ selected().length || '' }}
          </button>
        </footer>
      }
    </app-modal>
  `,
})
export class MediaPicker implements OnInit {
  protected readonly library = inject(MediaLibrary);
  readonly kinds = input.required<MediaKind[]>();
  readonly multiple = input(false);
  readonly done = output<MediaItem[]>();
  protected readonly query = signal('');
  /** Ids in the order chosen, which becomes the order they are added. */
  protected readonly selected = signal<string[]>([]);
  protected readonly bytes = formatBytes;
  protected readonly visible = computed(() => {
    const text = this.query().trim().toLowerCase();
    return this.library
      .items()
      .filter((m) => this.kinds().includes(m.kind) && m.title.toLowerCase().includes(text));
  });

  ngOnInit(): void {
    void this.library.load();
  }

  protected toggle(item: MediaItem): void {
    if (!this.multiple()) {
      this.done.emit([item]);
      return;
    }
    this.selected.update((ids) =>
      ids.includes(item.id) ? ids.filter((i) => i !== item.id) : [...ids, item.id],
    );
  }

  protected confirm(): void {
    this.done.emit(
      this.selected()
        .map((id) => this.library.byId(id))
        .filter((m) => m !== undefined),
    );
  }

  protected async upload(): Promise<void> {
    const files = await pickFiles(
      this.kinds()
        .map((k) => ACCEPT[k])
        .join(','),
      this.multiple(),
    );
    const added = (await this.library.uploadMany(files)).filter((m) =>
      this.kinds().includes(m.kind),
    );
    if (!added.length) return;
    if (!this.multiple()) this.done.emit([added[0]!]);
    else this.selected.update((ids) => [...ids, ...added.map((m) => m.id)]);
  }
}

/** Renders toasts and dialogs once, at the root of the app. */
@Component({
  selector: 'app-overlays',
  imports: [Modal, MediaPicker, ContextMenu],
  template: `
    @for (dialog of ui.dialogs(); track dialog) {
      @switch (dialog.type) {
        @case ('confirm') {
          <app-modal [heading]="dialog.title" (closed)="dialog.resolve(false)">
            @if (dialog.message) {
              <p>{{ dialog.message }}</p>
            }
            <footer class="row end">
              <button type="button" class="btn" (click)="dialog.resolve(false)">Cancel</button>
              <button
                type="button"
                autofocus
                class="btn"
                [class.danger]="dialog.danger"
                [class.primary]="!dialog.danger"
                (click)="dialog.resolve(true)"
              >
                {{ dialog.action }}
              </button>
            </footer>
          </app-modal>
        }
        @case ('prompt') {
          <app-modal [heading]="dialog.title" (closed)="dialog.resolve(null)">
            <form (submit)="submit($event, dialog)">
              <input
                name="value"
                autofocus
                autocomplete="off"
                [value]="dialog.value"
                [attr.aria-label]="dialog.title"
              />
              <footer class="row end">
                <button type="button" class="btn" (click)="dialog.resolve(null)">Cancel</button>
                <button type="submit" class="btn primary">{{ dialog.action }}</button>
              </footer>
            </form>
          </app-modal>
        }
        @case ('media') {
          <app-media-picker
            [kinds]="dialog.kinds"
            [multiple]="dialog.multiple"
            (done)="dialog.resolve($event)"
          />
        }
      }
    }
    @if (ui.menu(); as menu) {
      <app-context-menu [menu]="menu" (closed)="ui.menu.set(null)" />
    }
    <div class="toasts" role="status" aria-live="polite">
      @for (toast of ui.toasts(); track toast.id) {
        <button
          type="button"
          class="toast"
          [attr.data-tone]="toast.tone"
          (click)="ui.dismiss(toast.id)"
        >
          {{ toast.text }}
        </button>
      }
    </div>
  `,
})
export class Overlays {
  protected readonly ui = inject(Ui);

  protected submit(event: Event, dialog: Extract<DialogRequest, { type: 'prompt' }>): void {
    event.preventDefault();
    const value = new FormData(event.target as HTMLFormElement).get('value');
    const text = String(value ?? '').trim();
    if (text) dialog.resolve(text);
  }
}
