import { CdkDrag, CdkDragHandle, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { injectCollection, type Doc } from '../../core/collection';
import { MediaLibrary, mediaUrl } from '../../core/media';
import { Ui } from '../../core/ui';
import { downloadBlob, escapeHtml, moveItem, pickFiles, uid } from '../../core/util';
import { htmlToText, RichText } from '../../shared/rich-text';
import { Modal } from '../../shared/widgets';
import { splitSentences } from './split';

interface Message {
  id: string;
  html: string;
  highlighted: boolean;
  attachments: string[];
}

interface TextChat extends Doc {
  name: string;
  messages: Message[];
}

const toMessage = (sentence: string): Message => ({
  id: uid(),
  html: escapeHtml(sentence),
  highlighted: false,
  attachments: [],
});

@Component({
  selector: 'app-text-chats',
  imports: [RichText, Modal, CdkDropList, CdkDrag, CdkDragHandle],
  host: { class: 'page' },
  template: `
    @if (open(); as chat) {
      <header class="page-head no-print">
        <button type="button" class="btn" (click)="back()">← All</button>
        <h1>{{ chat.name }}</h1>
        <button type="button" class="btn small" (click)="rename(chat)">Rename</button>
        <label class="check"
          ><input
            type="checkbox"
            [checked]="onlyHighlighted()"
            (change)="onlyHighlighted.set($any($event.target).checked)"
          />
          Highlighted only</label
        >
        <input
          type="search"
          aria-label="Search in conversation"
          placeholder="Search"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
        />
        <button type="button" class="btn" (click)="importing.set('append')">Add text</button>
        <button type="button" class="btn" (click)="exportText(chat)">Export TXT</button>
        <button type="button" class="btn" (click)="print()">Print / PDF</button>
      </header>
      <div
        class="thread print-area"
        cdkDropList
        [cdkDropListDisabled]="filtered()"
        (cdkDropListDropped)="drop(chat, $event)"
      >
        <h2 class="print-only">{{ chat.name }}</h2>
        @for (message of messages(); track message.id; let i = $index) {
          <article class="bubble" cdkDrag [class.highlighted]="message.highlighted">
            @if (editing() === message.id) {
              <app-rich-text
                [html]="message.html"
                label="Message"
                (changed)="change(chat.id, message.id, { html: $event })"
              />
            } @else {
              <div [innerHTML]="message.html" (dblclick)="editing.set(message.id)"></div>
            }
            @for (mediaId of message.attachments; track mediaId) {
              @if (library.byId(mediaId); as media) {
                <figure>
                  @if (media.kind === 'image') {
                    <img [src]="url(media.id)" [alt]="media.title" />
                  } @else {
                    <video [src]="url(media.id)" controls preload="metadata"></video>
                  }
                  <button
                    type="button"
                    class="btn small no-print"
                    (click)="detach(chat.id, message, mediaId)"
                  >
                    Remove
                  </button>
                </figure>
              }
            }
            <div class="bubble-actions no-print">
              <span class="btn ghost icon drag-handle" cdkDragHandle aria-hidden="true">⠿</span>
              <button
                type="button"
                class="btn small"
                (click)="editing.set(editing() === message.id ? null : message.id)"
              >
                {{ editing() === message.id ? 'Done' : 'Edit' }}
              </button>
              <button
                type="button"
                class="btn small"
                [attr.aria-pressed]="message.highlighted"
                (click)="change(chat.id, message.id, { highlighted: !message.highlighted })"
              >
                Highlight
              </button>
              <button type="button" class="btn small" (click)="attach(chat.id, message, false)">
                Library
              </button>
              <button type="button" class="btn small" (click)="attach(chat.id, message, true)">
                Upload
              </button>
              <button type="button" class="btn small" (click)="copy(message)">Copy</button>
              <button type="button" class="btn small" (click)="insertAfter(chat, message.id)">
                + Below
              </button>
              <button
                type="button"
                class="btn small"
                aria-label="Move up"
                [disabled]="filtered() || i === 0"
                (click)="shift(chat, i, -1)"
              >
                ↑
              </button>
              <button
                type="button"
                class="btn small"
                aria-label="Move down"
                [disabled]="filtered() || i === chat.messages.length - 1"
                (click)="shift(chat, i, 1)"
              >
                ↓
              </button>
              <button
                type="button"
                class="btn small danger"
                (click)="removeMessage(chat.id, message.id)"
              >
                Delete
              </button>
            </div>
          </article>
        } @empty {
          <p class="empty">Nothing to show.</p>
        }
      </div>
      <form class="row composer no-print" (submit)="addSentence($event, chat.id)">
        <input
          class="grow"
          name="text"
          aria-label="New message"
          placeholder="Type a message and press Enter"
        />
        <button type="submit" class="btn primary">Add</button>
      </form>
    } @else {
      <header class="page-head">
        <h1>Text Chat</h1>
        @if (combining().length === 2) {
          <button type="button" class="btn" (click)="combine()">Combine 2 conversations</button>
        }
        <button type="button" class="btn primary" (click)="importing.set('new')">
          New from text
        </button>
      </header>
      <p class="muted">
        Paste any text and each sentence becomes an editable chat bubble. Tick two conversations to
        combine them.
      </p>
      @if (store.loaded() && !store.items().length) {
        <p class="empty">No conversations yet.</p>
      }
      <div class="tile-grid">
        @for (chat of store.items(); track chat.id) {
          <article class="tile">
            <button type="button" class="tile-open" (click)="openId.set(chat.id)">
              <strong>{{ chat.name }}</strong><span class="muted"
                >{{ chat.messages.length }} messages</span
              >
            </button>
            <div class="row">
              <label class="check grow"
                ><input
                  type="checkbox"
                  [checked]="combining().includes(chat.id)"
                  (change)="pick(chat.id)"
                />
                Combine</label
              >
              <button type="button" class="btn small danger" (click)="remove(chat)">Delete</button>
            </div>
          </article>
        }
      </div>
    }

    @if (importing(); as mode) {
      <app-modal
        [heading]="mode === 'new' ? 'New conversation' : 'Add text'"
        [wide]="true"
        (closed)="importing.set(null)"
      >
        <form class="col" (submit)="importText($event, mode)">
          @if (mode === 'new') {
            <label class="field"
              >Name <input name="name" autofocus maxlength="200" placeholder="Conversation name"
            /></label>
          }
          <label class="field"
            >Text <textarea name="text" rows="10" placeholder="Paste or type text here"></textarea>
          </label>
          <label class="field"
            >Or load a .txt file
            <input type="file" accept=".txt,text/plain" (change)="readFile($event)"
          /></label>
          <button type="submit" class="btn primary">Create bubbles</button>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .thread {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      max-width: 760px;
      margin: 0 auto;
    }
    .bubble {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px 16px 16px;
      padding: 0.7rem 0.9rem;
      overflow-wrap: anywhere;
    }
    .bubble.highlighted {
      background: #fff6bf;
      border-color: #e8c900;
    }
    .bubble figure {
      margin: 0.5rem 0 0;
    }
    .bubble img,
    .bubble video {
      max-height: 260px;
      border-radius: 8px;
      display: block;
      margin-bottom: 4px;
    }
    .bubble-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 0.4rem;
      opacity: 0.35;
    }
    .bubble:hover .bubble-actions,
    .bubble:focus-within .bubble-actions {
      opacity: 1;
    }
    .drag-handle {
      cursor: grab;
    }
    .composer {
      position: sticky;
      bottom: 0;
      max-width: 760px;
      margin: 0.8rem auto 0;
      background: var(--bg);
      padding: 0.5rem 0;
    }
  `,
})
export class TextChats implements OnInit {
  protected readonly store = injectCollection<TextChat>('textChats');
  protected readonly library = inject(MediaLibrary);
  private readonly ui = inject(Ui);
  protected readonly openId = signal<string | null>(null);
  protected readonly open = computed(() => this.store.byId(this.openId()));
  protected readonly editing = signal<string | null>(null);
  protected readonly search = signal('');
  protected readonly onlyHighlighted = signal(false);
  protected readonly combining = signal<string[]>([]);
  protected readonly importing = signal<'new' | 'append' | null>(null);
  protected readonly url = mediaUrl;
  protected readonly filtered = computed(
    () => this.onlyHighlighted() || this.search().trim() !== '',
  );
  protected readonly messages = computed(() => {
    const text = this.search().trim().toLowerCase();
    return (this.open()?.messages ?? []).filter(
      (m) =>
        (!this.onlyHighlighted() || m.highlighted) &&
        (!text || htmlToText(m.html).toLowerCase().includes(text)),
    );
  });

  ngOnInit(): void {
    void this.store.load();
    void this.library.load();
  }

  protected back(): void {
    const id = this.openId();
    if (id) void this.store.flush(id);
    this.openId.set(null);
    this.editing.set(null);
    this.search.set('');
    this.onlyHighlighted.set(false);
  }

  /** Always edits the latest message list, so overlapping changes cannot drop each other. */
  private edit(chatId: string, change: (messages: Message[]) => Message[]): void {
    const chat = this.store.byId(chatId);
    if (chat) this.store.patch(chatId, { messages: change(chat.messages) });
  }

  protected change(chatId: string, messageId: string, patch: Partial<Message>): void {
    this.edit(chatId, (list) => list.map((m) => (m.id === messageId ? { ...m, ...patch } : m)));
  }

  protected async copy(message: Message): Promise<void> {
    try {
      await navigator.clipboard.writeText(htmlToText(message.html));
      this.ui.success('Copied');
    } catch {
      this.ui.toast('The browser did not allow copying', 'error');
    }
  }

  protected removeMessage(chatId: string, messageId: string): void {
    this.edit(chatId, (list) => list.filter((m) => m.id !== messageId));
  }

  protected insertAfter(chat: TextChat, messageId: string): void {
    const blank = toMessage('');
    this.edit(chat.id, (list) => {
      const at = list.findIndex((m) => m.id === messageId) + 1;
      return [...list.slice(0, at), blank, ...list.slice(at)];
    });
    this.editing.set(blank.id);
  }

  protected shift(chat: TextChat, index: number, by: number): void {
    this.edit(chat.id, (list) => moveItem(list, index, index + by));
  }

  protected drop(chat: TextChat, event: CdkDragDrop<unknown>): void {
    this.edit(chat.id, (list) => moveItem(list, event.previousIndex, event.currentIndex));
  }

  protected async attach(chatId: string, message: Message, upload: boolean): Promise<void> {
    try {
      let ids: string[];
      if (upload) {
        const files = await pickFiles('image/*,video/*');
        if (!files.length) return;
        const folder = await this.library.ensureFolder('Text chat uploads');
        ids = (await this.library.uploadMany(files, folder))
          .filter((m) => m.kind === 'image' || m.kind === 'video')
          .map((m) => m.id);
      } else {
        ids = (await this.ui.pickMedia(['image', 'video'], true)).map((m) => m.id);
      }
      const current = this.store.byId(chatId)?.messages.find((m) => m.id === message.id);
      if (current && ids.length)
        this.change(chatId, message.id, {
          attachments: [...new Set([...current.attachments, ...ids])],
        });
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected detach(chatId: string, message: Message, mediaId: string): void {
    this.change(chatId, message.id, {
      attachments: message.attachments.filter((id) => id !== mediaId),
    });
  }

  protected addSentence(event: Event, chatId: string): void {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const text = String(new FormData(form).get('text') ?? '').trim();
    if (!text) return;
    this.edit(chatId, (list) => [...list, toMessage(text)]);
    form.reset();
  }

  protected async readFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) {
      this.ui.toast('Choose a text file smaller than 2 MB', 'error');
      return;
    }
    input.closest('form')!.querySelector('textarea')!.value = await file.text();
  }

  protected async importText(event: Event, mode: 'new' | 'append'): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const messages = splitSentences(String(data.get('text') ?? '')).map(toMessage);
    if (!messages.length) {
      this.ui.toast('Add some text first', 'error');
      return;
    }
    this.importing.set(null);
    if (mode === 'append') {
      this.edit(this.openId()!, (list) => [...list, ...messages]);
      return;
    }
    try {
      const name =
        String(data.get('name') ?? '').trim() || htmlToText(messages[0]!.html).slice(0, 60);
      this.openId.set((await this.store.create({ name, messages })).id);
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected pick(id: string): void {
    this.combining.update((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : [...list, id].slice(-2),
    );
  }

  protected async combine(): Promise<void> {
    const [first, second] = this.combining().map((id) => this.store.byId(id));
    if (!first || !second) return;
    const name = await this.ui.prompt(
      'Name the combined conversation',
      `${first.name} + ${second.name}`,
      'Combine',
    );
    if (!name) return;
    try {
      const messages = [...first.messages, ...second.messages].map((m) => ({ ...m, id: uid() }));
      await this.store.create({ name, messages });
      this.combining.set([]);
      this.ui.success('Created a combined copy. The originals are unchanged.');
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected async rename(chat: TextChat): Promise<void> {
    const name = await this.ui.prompt('Rename conversation', chat.name);
    if (name) this.store.patch(chat.id, { name }, 0);
  }

  protected async remove(chat: TextChat): Promise<void> {
    if (!(await this.ui.confirm(`Delete “${chat.name}”?`, 'This cannot be undone.'))) return;
    try {
      await this.store.remove(chat.id);
      this.combining.update((list) => list.filter((id) => id !== chat.id));
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected exportText(chat: TextChat): void {
    const body = chat.messages.map((m) => htmlToText(m.html)).join('\r\n');
    downloadBlob(new Blob([body], { type: 'text/plain' }), `${chat.name}.txt`);
  }

  protected print(): void {
    this.editing.set(null);
    setTimeout(() => window.print());
  }
}
