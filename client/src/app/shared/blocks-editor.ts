import { Component, inject, input, OnInit, output } from '@angular/core';
import { MediaLibrary, mediaUrl } from '../core/media';
import { Ui } from '../core/ui';
import { moveItem, pickFiles, uid } from '../core/util';
import { RichText } from './rich-text';

export type Block =
  | { id: string; type: 'text'; html: string }
  | { id: string; type: 'media'; mediaId: string }
  | { id: string; type: 'link'; url: string; label: string }
  | { id: string; type: 'checklist'; items: { id: string; text: string; done: boolean }[] };

export const isWebUrl = (url: string): boolean => /^https?:\/\/[^\s]+$/i.test(url);

/** The body of notes and tasks: a list of text, checklist, picture/video and link blocks. */
@Component({
  selector: 'app-blocks-editor',
  imports: [RichText],
  template: `
    @for (block of blocks(); track block.id; let i = $index; let first = $first; let last = $last) {
      <div class="block">
        <div class="block-main">
          @switch (block.type) {
            @case ('text') {
              <app-rich-text
                [html]="block.html"
                label="Text"
                (changed)="replace(block.id, { html: $event })"
              />
            }
            @case ('media') {
              @let item = library.byId(block.mediaId);
              @if (item?.kind === 'video') {
                <video
                  class="block-media"
                  [src]="url(block.mediaId)"
                  controls
                  preload="metadata"
                ></video>
              } @else if (item?.kind === 'audio') {
                <audio [src]="url(block.mediaId)" controls></audio>
              } @else if (item) {
                <img class="block-media" [src]="url(block.mediaId)" [alt]="item.title" />
              } @else if (library.loaded()) {
                <p class="muted">This file was removed from the library.</p>
              }
            }
            @case ('link') {
              <a class="link-card" [href]="block.url" target="_blank" rel="noopener noreferrer">
                🔗 <strong>{{ block.label || block.url }}</strong>
              </a>
            }
            @case ('checklist') {
              <ul class="checklist">
                @for (entry of block.items; track entry.id) {
                  <li class="row">
                    <input
                      type="checkbox"
                      [checked]="entry.done"
                      [attr.aria-label]="'Done: ' + entry.text"
                      (change)="entryChange(block, entry.id, { done: $any($event.target).checked })"
                    />
                    <input
                      class="grow"
                      [class.done]="entry.done"
                      aria-label="Checklist item"
                      placeholder="List item"
                      [value]="entry.text"
                      (input)="entryChange(block, entry.id, { text: $any($event.target).value })"
                      (keydown.enter)="addEntry(block)"
                    />
                    <button
                      type="button"
                      class="btn ghost icon"
                      aria-label="Remove item"
                      (click)="removeEntry(block, entry.id)"
                    >
                      ✕
                    </button>
                  </li>
                }
              </ul>
              <button type="button" class="btn small" (click)="addEntry(block)">+ Item</button>
            }
          }
        </div>
        <div class="block-actions">
          <button
            type="button"
            class="btn ghost icon"
            aria-label="Move block up"
            [disabled]="first"
            (click)="move(i, -1)"
          >
            ↑
          </button>
          <button
            type="button"
            class="btn ghost icon"
            aria-label="Move block down"
            [disabled]="last"
            (click)="move(i, 1)"
          >
            ↓
          </button>
          <button
            type="button"
            class="btn ghost icon"
            aria-label="Remove block"
            (click)="remove(block.id)"
          >
            🗑
          </button>
        </div>
      </div>
    }
    <div class="row wrap">
      <button
        type="button"
        class="btn small"
        (click)="add({ id: newId(), type: 'text', html: '' })"
      >
        + Text
      </button>
      <button type="button" class="btn small" (click)="addChecklist()">+ Checklist</button>
      <button type="button" class="btn small" (click)="fromLibrary()">+ From library</button>
      <button type="button" class="btn small" (click)="upload()">+ Upload</button>
      <button type="button" class="btn small" (click)="addLink()">+ Link</button>
    </div>
  `,
})
export class BlocksEditor implements OnInit {
  protected readonly library = inject(MediaLibrary);
  private readonly ui = inject(Ui);
  readonly blocks = input.required<Block[]>();
  /** Library folder that direct uploads go into. */
  readonly uploadFolder = input.required<string>();
  readonly changed = output<Block[]>();
  protected readonly url = mediaUrl;
  protected readonly newId = uid;

  ngOnInit(): void {
    void this.library.load();
  }

  protected add(...blocks: Block[]): void {
    this.changed.emit([...this.blocks(), ...blocks]);
  }

  protected remove(id: string): void {
    this.changed.emit(this.blocks().filter((b) => b.id !== id));
  }

  protected move(index: number, by: number): void {
    this.changed.emit(moveItem(this.blocks(), index, index + by));
  }

  protected replace(id: string, patch: object): void {
    this.changed.emit(this.blocks().map((b) => (b.id === id ? ({ ...b, ...patch } as Block) : b)));
  }

  protected addChecklist(): void {
    this.add({ id: uid(), type: 'checklist', items: [{ id: uid(), text: '', done: false }] });
  }

  protected addEntry(block: Extract<Block, { type: 'checklist' }>): void {
    this.replace(block.id, { items: [...block.items, { id: uid(), text: '', done: false }] });
  }

  protected entryChange(
    block: Extract<Block, { type: 'checklist' }>,
    id: string,
    patch: object,
  ): void {
    this.replace(block.id, {
      items: block.items.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    });
  }

  protected removeEntry(block: Extract<Block, { type: 'checklist' }>, id: string): void {
    this.replace(block.id, { items: block.items.filter((e) => e.id !== id) });
  }

  protected async fromLibrary(): Promise<void> {
    const items = await this.ui.pickMedia(['image', 'video', 'audio'], true);
    if (items.length)
      this.add(...items.map((m): Block => ({ id: uid(), type: 'media', mediaId: m.id })));
  }

  protected async upload(): Promise<void> {
    const files = await pickFiles('image/*,video/*,audio/*');
    if (!files.length) return;
    try {
      const folderId = await this.library.ensureFolder(this.uploadFolder());
      const items = await this.library.uploadMany(files, folderId);
      if (items.length)
        this.add(...items.map((m): Block => ({ id: uid(), type: 'media', mediaId: m.id })));
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected async addLink(): Promise<void> {
    let url = await this.ui.prompt('Link address', 'https://', 'Next');
    if (!url) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    if (!isWebUrl(url)) {
      this.ui.toast('Only http and https links can be added', 'error');
      return;
    }
    const label = await this.ui.prompt('Link label', new URL(url).hostname, 'Add link');
    if (label !== null) this.add({ id: uid(), type: 'link', url, label });
  }
}
