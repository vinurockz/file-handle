import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { injectCollection, type Doc } from '../../core/collection';
import { MediaLibrary, mediaUrl } from '../../core/media';
import { Ui } from '../../core/ui';
import { uid } from '../../core/util';
import { BlocksEditor, type Block } from '../../shared/blocks-editor';
import { htmlToText } from '../../shared/rich-text';
import { Modal } from '../../shared/widgets';

export interface Note extends Doc {
  title: string;
  color: string;
  pinned: boolean;
  archived: boolean;
  labels: string[];
  blocks: Block[];
}

export const NOTE_COLORS = [
  '#ffffff',
  '#fde2e4',
  '#fde8cc',
  '#fff6bf',
  '#d9f5d6',
  '#d2f2ef',
  '#dbe9ff',
  '#eadcff',
  '#fcdcf0',
];

export function noteText(note: Pick<Note, 'title' | 'blocks' | 'labels'>): string {
  const body = note.blocks.map((b) =>
    b.type === 'text'
      ? htmlToText(b.html)
      : b.type === 'link'
        ? `${b.label} ${b.url}`
        : b.type === 'checklist'
          ? b.items.map((i) => i.text).join(' ')
          : '',
  );
  return [note.title, ...note.labels, ...body].join(' ');
}

@Component({
  selector: 'app-notes',
  imports: [BlocksEditor, Modal],
  host: { class: 'page' },
  template: `
    <header class="page-head">
      <h1>{{ showArchived() ? 'Archived notes' : 'Notes' }}</h1>
      <input
        type="search"
        aria-label="Search notes"
        placeholder="Search notes"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
      />
      <button
        type="button"
        class="btn"
        [attr.aria-pressed]="showArchived()"
        (click)="showArchived.set(!showArchived())"
      >
        Archive
      </button>
      <button type="button" class="btn primary" (click)="create()">New note</button>
    </header>
    @if (labels().length) {
      <div class="row wrap">
        @for (name of labels(); track name) {
          <button
            type="button"
            class="btn small"
            [attr.aria-pressed]="label() === name"
            (click)="label.set(label() === name ? '' : name)"
          >
            # {{ name }}
          </button>
        }
      </div>
    }
    @if (!store.loaded()) {
      <p class="empty">Loading notes…</p>
    } @else if (!sections().length) {
      <p class="empty">No notes to show.</p>
    }
    @for (section of sections(); track section.title) {
      <h3 class="muted">{{ section.title }}</h3>
      <div class="notes">
        @for (note of section.notes; track note.id) {
          <article class="note" [style.background]="note.color">
            <button type="button" class="tile-open" (click)="openId.set(note.id)">
              <strong>{{ note.title || 'Untitled' }}</strong>
              @for (block of note.blocks.slice(0, 5); track block.id) {
                @switch (block.type) {
                  @case ('text') {
                    <span class="preview">{{ text(block.html) }}</span>
                  }
                  @case ('link') {
                    <span>🔗 {{ block.label || block.url }}</span>
                  }
                  @case ('checklist') {
                    @for (item of block.items.slice(0, 5); track item.id) {
                      <span [class.done]="item.done"
                        >{{ item.done ? '☑' : '☐' }} {{ item.text }}</span
                      >
                    }
                  }
                  @case ('media') {
                    @if (library.byId(block.mediaId); as media) {
                      @if (media.kind === 'image') {
                        <img [src]="url(media.id)" [alt]="media.title" loading="lazy" />
                      } @else {
                        <span>📎 {{ media.title }}</span>
                      }
                    }
                  }
                }
              }
              @for (name of note.labels; track name) {
                <span class="chip">{{ name }}</span>
              }
            </button>
            <div class="row end">
              <button
                type="button"
                class="btn ghost icon"
                [attr.aria-label]="note.pinned ? 'Unpin note' : 'Pin note'"
                (click)="store.patch(note.id, { pinned: !note.pinned }, 0)"
              >
                {{ note.pinned ? '📌' : '📍' }}
              </button>
              <button
                type="button"
                class="btn ghost icon"
                [attr.aria-label]="note.archived ? 'Unarchive note' : 'Archive note'"
                (click)="store.patch(note.id, { archived: !note.archived }, 0)"
              >
                🗄
              </button>
              <button
                type="button"
                class="btn ghost icon"
                aria-label="Delete note"
                (click)="remove(note)"
              >
                🗑
              </button>
            </div>
          </article>
        }
      </div>
    }

    @if (open(); as note) {
      <app-modal [heading]="note.title || 'Untitled note'" [wide]="true" (closed)="close(note.id)">
        <input
          aria-label="Title"
          placeholder="Title"
          maxlength="300"
          [value]="note.title"
          (input)="store.patch(note.id, { title: $any($event.target).value })"
        />
        <div class="note-body" [style.background]="note.color">
          <app-blocks-editor
            [blocks]="note.blocks"
            uploadFolder="Note uploads"
            (changed)="store.patch(note.id, { blocks: $event })"
          />
        </div>
        <label class="field">
          Labels (comma separated)
          <input
            [value]="note.labels.join(', ')"
            (change)="setLabels(note.id, $any($event.target).value)"
          />
        </label>
        <div class="row wrap">
          @for (color of colors; track color) {
            <button
              type="button"
              class="swatch"
              [style.background]="color"
              [attr.aria-label]="'Colour ' + color"
              [attr.aria-pressed]="note.color === color"
              (click)="store.patch(note.id, { color }, 0)"
            ></button>
          }
          <input
            type="color"
            aria-label="Custom colour"
            [value]="note.color"
            (input)="store.patch(note.id, { color: $any($event.target).value })"
          />
          <span class="grow"></span>
          <button type="button" class="btn primary" (click)="close(note.id)">Done</button>
        </div>
      </app-modal>
    }
  `,
  styles: `
    .notes {
      columns: 240px;
      column-gap: 0.8rem;
      margin-bottom: 1rem;
    }
    .note {
      break-inside: avoid;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0.75rem;
      margin-bottom: 0.8rem;
    }
    .note .tile-open {
      width: 100%;
    }
    .preview {
      white-space: pre-line;
      max-height: 8.5em;
      overflow: hidden;
    }
    .done {
      text-decoration: line-through;
      opacity: 0.6;
    }
    .note-body {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      padding: 0.7rem;
      border-radius: 8px;
    }
  `,
})
export class Notes implements OnInit {
  protected readonly store = injectCollection<Note>('notes');
  protected readonly library = inject(MediaLibrary);
  private readonly ui = inject(Ui);
  protected readonly query = signal('');
  protected readonly label = signal('');
  protected readonly showArchived = signal(false);
  protected readonly openId = signal<string | null>(null);
  protected readonly open = computed(() => this.store.byId(this.openId()));
  protected readonly colors = NOTE_COLORS;
  protected readonly url = mediaUrl;
  protected readonly text = htmlToText;
  protected readonly labels = computed(() =>
    [...new Set(this.store.items().flatMap((n) => n.labels))].sort(),
  );
  protected readonly sections = computed(() => {
    const text = this.query().trim().toLowerCase();
    const matches = this.store
      .items()
      .filter((n) => n.archived === this.showArchived())
      .filter((n) => !this.label() || n.labels.includes(this.label()))
      .filter((n) => !text || noteText(n).toLowerCase().includes(text))
      .sort((a, b) => b.createdAt - a.createdAt);
    return [
      { title: 'Pinned', notes: matches.filter((n) => n.pinned) },
      { title: 'Others', notes: matches.filter((n) => !n.pinned) },
    ].filter((s) => s.notes.length);
  });

  ngOnInit(): void {
    void this.store.load();
    void this.library.load();
  }

  protected async create(): Promise<void> {
    try {
      const note = await this.store.create({ blocks: [{ id: uid(), type: 'text', html: '' }] });
      this.openId.set(note.id);
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected close(id: string): void {
    this.openId.set(null);
    void this.store.flush(id);
  }

  protected setLabels(id: string, value: string): void {
    const labels = [
      ...new Set(
        value
          .split(',')
          .map((l) => l.trim().slice(0, 40))
          .filter(Boolean),
      ),
    ].slice(0, 30);
    this.store.patch(id, { labels });
  }

  protected async remove(note: Note): Promise<void> {
    if (!(await this.ui.confirm(`Delete “${note.title || 'Untitled'}”?`, 'This cannot be undone.')))
      return;
    try {
      await this.store.remove(note.id);
    } catch (error) {
      this.ui.error(error);
    }
  }
}
