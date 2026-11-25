import {
  afterEveryRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Api, errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';
import { MediaLibrary, mediaFilename, mediaUrl } from '../../core/media';
import { Ui } from '../../core/ui';
import { downloadBlob, formatBytes, pickFiles, uid } from '../../core/util';
import { Modal } from '../../shared/widgets';
import {
  preview,
  reactionGroups,
  titleOf,
  type ChatFile,
  type Conversation,
  type Message,
} from './chat-model';
import { chatPdf } from './chat-pdf';
import { ChatStore } from './chat-store';
import { PeoplePicker, type PeopleChoice } from './people-picker';

interface PendingFile {
  key: string;
  name: string;
  file: ChatFile | null;
}

interface Draft {
  text: string;
  replyTo: Message | null;
  files: PendingFile[];
}

const EMPTY_DRAFT: Draft = { text: '', replyTo: null, files: [] };
const MAX_FILES = 10;
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const EMOJIS = [
  '😀',
  '😄',
  '😁',
  '😂',
  '🤣',
  '😊',
  '😍',
  '😘',
  '😎',
  '🤔',
  '😴',
  '😢',
  '😭',
  '😡',
  '🥳',
  '🤝',
  '👍',
  '👎',
  '👏',
  '🙏',
  '💪',
  '👌',
  '✌️',
  '👋',
  '❤️',
  '💔',
  '🔥',
  '✨',
  '🎉',
  '🎂',
  '✅',
  '❌',
  '⭐',
  '☕',
  '🌹',
  '🚀',
];

@Component({
  selector: 'app-chat',
  imports: [PeoplePicker, Modal],
  templateUrl: './chat.html',
  styleUrl: './chat.scss',
  host: { '(document:visibilitychange)': 'readIfVisible()' },
})
export class Chat {
  protected readonly store = inject(ChatStore);
  protected readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly ui = inject(Ui);
  private readonly library = inject(MediaLibrary);
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');

  protected readonly myId = computed(() => this.auth.user()!.id);
  protected readonly filter = signal('');
  protected readonly picking = signal<'new' | 'add' | null>(null);
  protected readonly showInfo = signal(false);
  protected readonly editing = signal<{ id: string; text: string } | null>(null);
  protected readonly emojiOpen = signal(false);
  protected readonly reactingTo = signal<string | null>(null);
  protected readonly viewing = signal<ChatFile | null>(null);
  protected readonly searching = signal(false);
  protected readonly results = signal<Message[] | null>(null);
  protected readonly recording = signal(false);
  protected readonly sending = signal(false);
  /** Each conversation keeps its own unsent text and files. */
  private readonly drafts = signal<ReadonlyMap<string, Draft>>(new Map());
  protected readonly draft = computed(
    () => this.drafts().get(this.store.activeId() ?? '') ?? EMPTY_DRAFT,
  );

  protected readonly quick = QUICK;
  protected readonly emojis = EMOJIS;
  protected readonly bytes = formatBytes;
  protected readonly preview = preview;
  protected readonly groups = reactionGroups;

  protected readonly conversations = computed(() => {
    const text = this.filter().trim().toLowerCase();
    return this.store
      .conversations()
      .filter((c) => !text || titleOf(c, this.myId()).toLowerCase().includes(text));
  });
  protected readonly members = computed(
    () => new Map(this.store.active()?.members.map((m) => [m.id, m]) ?? []),
  );
  protected readonly typers = computed(() => {
    const id = this.store.activeId();
    const names = [...this.store.typing()]
      .filter((key) => key.startsWith(`${id}:`))
      .map((key) => this.members().get(key.split(':')[1]!)?.name)
      .filter(Boolean);
    return names.length ? `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} typing…` : '';
  });
  protected readonly isAdmin = computed(() => this.members().get(this.myId())?.role === 'admin');
  protected readonly seenBy = computed(() => {
    const mine = [...this.store.thread().messages]
      .reverse()
      .find((m) => m.senderId === this.myId() && !m.deletedAt);
    if (!mine) return null;
    const names = (this.store.active()?.members ?? [])
      .filter((m) => m.id !== this.myId() && m.lastReadSeq >= mine.seq)
      .map((m) => m.name);
    return { id: mine.id, label: names.length ? `Seen by ${names.join(', ')}` : 'Sent' };
  });

  private stickToBottom = true;
  private restoreFromBottom: number | null = null;
  private recorder: MediaRecorder | null = null;

  constructor() {
    effect(() => {
      this.store.activeId();
      untracked(() => {
        this.stickToBottom = true;
        this.showInfo.set(false);
        this.editing.set(null);
        this.emojiOpen.set(false);
        this.reactingTo.set(null);
        this.searching.set(false);
        this.results.set(null);
      });
    });
    effect(() => {
      this.store.thread().messages.length;
      this.store.active()?.unread;
      untracked(() => this.readIfVisible());
    });
    afterEveryRender(() => {
      const element = this.list()?.nativeElement;
      if (!element) return;
      if (this.restoreFromBottom !== null && !this.store.thread().loading) {
        element.scrollTop = element.scrollHeight - this.restoreFromBottom;
        this.restoreFromBottom = null;
      } else if (this.stickToBottom) {
        element.scrollTop = element.scrollHeight;
      }
    });
    inject(DestroyRef).onDestroy(() => this.stopRecording(true));
  }

  protected readIfVisible(): void {
    if (document.visibilityState === 'visible') void this.store.markRead();
  }

  protected title(conversation: Conversation): string {
    return titleOf(conversation, this.myId());
  }

  protected partner(conversation: Conversation) {
    return conversation.type === 'direct'
      ? conversation.members.find((m) => m.id !== this.myId())
      : null;
  }

  protected subtitle(conversation: Conversation): string {
    const partner = this.partner(conversation);
    if (partner) return partner.online ? 'Online' : 'Offline';
    return `${conversation.members.length} members · ${conversation.members.filter((m) => m.online).length} online`;
  }

  protected open(id: string | null): void {
    this.stopRecording(true);
    this.store.open(id);
  }

  protected scrolled(): void {
    const element = this.list()!.nativeElement;
    this.stickToBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  }

  protected loadOlder(): void {
    const element = this.list()!.nativeElement;
    this.stickToBottom = false;
    this.restoreFromBottom = element.scrollHeight - element.scrollTop;
    void this.store.loadThread(this.store.activeId()!, true);
  }

  protected day(time: number): string {
    return new Date(time).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  protected clock(time: number): string {
    return new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  protected newDay(index: number): boolean {
    const list = this.store.thread().messages;
    return index === 0 || this.day(list[index - 1]!.createdAt) !== this.day(list[index]!.createdAt);
  }

  protected fileUrl(file: ChatFile, download = false): string {
    return `/api/chat/files/${file.id}${download ? '?download=1' : ''}`;
  }

  private async attempt(work: () => Promise<unknown>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (error) {
      this.ui.error(error);
      return false;
    }
  }

  // --- Composer ---------------------------------------------------------------
  private patchDraft(id: string, change: (draft: Draft) => Draft): void {
    this.drafts.update((map) => new Map(map).set(id, change(map.get(id) ?? EMPTY_DRAFT)));
  }

  protected typed(text: string): void {
    const id = this.store.activeId();
    if (!id) return;
    this.patchDraft(id, (d) => ({ ...d, text }));
    if (text) this.store.sendTyping();
  }

  protected composerKey(event: KeyboardEvent): void {
    // `isComposing` protects input methods used for Hindi, Chinese, Japanese and others.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.send();
    }
  }

  protected addEmoji(emoji: string): void {
    const field = this.composer()!.nativeElement;
    const { selectionStart: from, selectionEnd: to, value } = field;
    this.typed(value.slice(0, from) + emoji + value.slice(to));
    setTimeout(() => {
      field.focus();
      field.setSelectionRange(from + emoji.length, from + emoji.length);
    });
  }

  protected reply(message: Message): void {
    this.patchDraft(message.conversationId, (d) => ({ ...d, replyTo: message }));
    this.composer()?.nativeElement.focus();
  }

  protected cancelReply(): void {
    this.patchDraft(this.store.activeId()!, (d) => ({ ...d, replyTo: null }));
  }

  /** Files upload as soon as they are chosen, into the conversation they were chosen for. */
  private async attachFiles(files: File[], conversationId = this.store.activeId()): Promise<void> {
    if (!conversationId) return;
    for (const file of files) {
      if ((this.drafts().get(conversationId)?.files.length ?? 0) >= MAX_FILES) {
        this.ui.toast(`A message can have up to ${MAX_FILES} attachments`, 'error');
        return;
      }
      const key = uid();
      this.patchDraft(conversationId, (d) => ({
        ...d,
        files: [...d.files, { key, name: file.name, file: null }],
      }));
      const form = new FormData();
      form.append('file', file, file.name);
      try {
        const uploaded = await this.api.post<ChatFile>(
          `/chat/conversations/${conversationId}/files`,
          form,
        );
        this.patchDraft(conversationId, (d) => ({
          ...d,
          files: d.files.map((p) => (p.key === key ? { ...p, file: uploaded } : p)),
        }));
      } catch (error) {
        this.patchDraft(conversationId, (d) => ({
          ...d,
          files: d.files.filter((p) => p.key !== key),
        }));
        this.ui.toast(`${file.name}: ${errorMessage(error)}`, 'error');
      }
    }
  }

  protected removePending(key: string): void {
    this.patchDraft(this.store.activeId()!, (d) => ({
      ...d,
      files: d.files.filter((p) => p.key !== key),
    }));
  }

  protected async chooseFiles(accept: string): Promise<void> {
    const id = this.store.activeId();
    await this.attachFiles(await pickFiles(accept), id);
  }

  protected async fromLibrary(): Promise<void> {
    const conversationId = this.store.activeId();
    if (!this.auth.workspaceId()) return;
    const items = await this.ui.pickMedia(['image', 'video', 'audio', 'pdf'], true);
    await this.attempt(async () => {
      for (const item of items) {
        // Chat keeps its own copy, so other members can see it without access to your library.
        const response = await fetch(mediaUrl(item.id));
        if (!response.ok) throw new Error(`Could not read “${item.title}”`);
        await this.attachFiles(
          [new File([await response.blob()], mediaFilename(item), { type: item.mime })],
          conversationId,
        );
      }
    });
  }

  protected pasted(event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    void this.attachFiles(files);
  }

  protected dragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  }

  protected dropped(event: DragEvent): void {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    void this.attachFiles(files);
  }

  protected async record(): Promise<void> {
    if (this.recording()) {
      this.stopRecording(false);
      return;
    }
    const conversationId = this.store.activeId();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (conversationId !== this.store.activeId()) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recorder.mimeType && chunks.length && !this.discardRecording) {
          const type = recorder.mimeType.split(';')[0]!.replace('video/', 'audio/');
          const name = `Voice message ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${type.includes('mp4') ? 'm4a' : 'weba'}`;
          void this.attachFiles([new File(chunks, name, { type })], conversationId);
        }
      };
      this.discardRecording = false;
      this.recorder = recorder;
      recorder.start();
      this.recording.set(true);
    } catch {
      this.ui.toast(
        'The microphone is not available. Allow microphone access and try again.',
        'error',
      );
    }
  }

  private discardRecording = false;

  private stopRecording(discard: boolean): void {
    if (!this.recorder || this.recorder.state === 'inactive') return;
    this.discardRecording = discard;
    this.recorder.stop();
    this.recorder = null;
    this.recording.set(false);
  }

  protected canSend(): boolean {
    const draft = this.draft();
    return (
      !this.sending() &&
      draft.files.every((f) => f.file) &&
      (!!draft.text.trim() || draft.files.length > 0)
    );
  }

  protected async send(): Promise<void> {
    const id = this.store.activeId();
    if (!id || !this.canSend()) return;
    const draft = this.draft();
    this.sending.set(true);
    this.stickToBottom = true;
    const sent = await this.attempt(() =>
      this.store.send(
        id,
        draft.text.trim() ? draft.text : '',
        draft.replyTo?.id ?? null,
        draft.files.map((f) => f.file!.id),
      ),
    );
    this.sending.set(false);
    if (!sent) return;
    // Keep anything typed or attached while the message was on its way.
    const files = new Set(draft.files.map((f) => f.key));
    this.patchDraft(id, (d) => ({
      text: d.text === draft.text ? '' : d.text,
      replyTo: d.replyTo === draft.replyTo ? null : d.replyTo,
      files: d.files.filter((f) => !files.has(f.key)),
    }));
    this.emojiOpen.set(false);
  }

  // --- Message actions -------------------------------------------------------
  protected startEdit(message: Message): void {
    this.editing.set({ id: message.id, text: message.text });
  }

  protected async saveEdit(message: Message): Promise<void> {
    const edit = this.editing();
    if (!edit) return;
    if (
      edit.text === message.text ||
      (await this.attempt(() => this.store.edit(message, edit.text)))
    )
      this.editing.set(null);
  }

  protected async deleteMessage(message: Message): Promise<void> {
    if (
      await this.ui.confirm(
        'Delete this message?',
        'It is removed for everyone, including any attachments.',
      )
    ) {
      await this.attempt(() => this.store.remove(message));
    }
  }

  protected react(message: Message, emoji: string): void {
    this.reactingTo.set(null);
    void this.attempt(() => this.store.react(message, emoji));
  }

  protected async copy(text: string): Promise<void> {
    if (await this.attempt(() => navigator.clipboard.writeText(text))) this.ui.success('Copied');
  }

  /** Copies an attachment into this workspace's file library. */
  protected async saveToLibrary(file: ChatFile): Promise<void> {
    await this.attempt(async () => {
      const response = await fetch(this.fileUrl(file));
      if (!response.ok) throw new Error('That attachment is no longer available');
      const folder = await this.library.ensureFolder('Chat uploads');
      await this.library.upload(await response.blob(), file.name, folder);
      this.ui.success('Saved to your library');
    });
  }

  protected async search(event: Event): Promise<void> {
    event.preventDefault();
    const id = this.store.activeId();
    const q = String(new FormData(event.target as HTMLFormElement).get('q') ?? '').trim();
    if (!id || !q) {
      this.results.set(null);
      return;
    }
    await this.attempt(async () => {
      const page = await this.api.get<{ messages: Message[] }>(
        `/chat/conversations/${id}/messages?limit=100&q=${encodeURIComponent(q)}`,
      );
      if (this.store.activeId() === id) this.results.set(page.messages);
    });
  }

  protected async exportChat(format: 'pdf' | 'txt'): Promise<void> {
    const conversation = this.store.active();
    if (!conversation) return;
    await this.attempt(async () => {
      const all: Message[] = [];
      let before: number | undefined;
      for (;;) {
        const page: { messages: Message[]; hasMore: boolean } = await this.api.get(
          `/chat/conversations/${conversation.id}/messages?limit=100${before ? `&before=${before}` : ''}`,
        );
        all.unshift(...page.messages);
        before = page.messages[0]?.seq;
        if (!page.hasMore || !before) break;
      }
      if (format === 'pdf') {
        const people = new Map(conversation.members.map((m) => [m.id, m]));
        downloadBlob(
          await chatPdf(this.title(conversation), all, people, this.myId()),
          `${this.title(conversation)}.pdf`,
        );
        return;
      }
      const names = new Map(conversation.members.map((m) => [m.id, m.name]));
      const lines = all.map((m) => {
        const body = m.deletedAt
          ? '(deleted)'
          : [m.text, ...m.attachments.map((a) => `[file: ${a.name}]`)].filter(Boolean).join(' ');
        return `[${new Date(m.createdAt).toLocaleString()}] ${names.get(m.senderId) ?? 'Former member'}: ${body}`;
      });
      downloadBlob(
        new Blob([lines.join('\r\n')], { type: 'text/plain;charset=utf-8' }),
        `${this.title(conversation)}.txt`,
      );
    });
  }

  // --- Conversations ---------------------------------------------------------
  protected async peoplePicked({ users, groupName }: PeopleChoice): Promise<void> {
    const mode = this.picking();
    this.picking.set(null);
    const ids = users.map((u) => u.id);
    await this.attempt(() =>
      mode === 'add'
        ? this.store.addMembers(this.store.activeId()!, ids)
        : this.store.create(ids.length > 1 ? 'group' : 'direct', ids, groupName),
    );
  }

  protected memberIds(): string[] {
    return this.store.active()?.members.map((m) => m.id) ?? [];
  }

  protected async rename(conversation: Conversation): Promise<void> {
    const name = await this.ui.prompt('Group name', conversation.name);
    if (name)
      await this.attempt(() => this.store.update(conversation.id, { name: name.slice(0, 80) }));
  }

  protected async describe(conversation: Conversation, description: string): Promise<void> {
    if (description.trim() === conversation.description) return;
    await this.attempt(() =>
      this.store.update(conversation.id, { description: description.slice(0, 500) }),
    );
  }

  protected async changeImage(conversation: Conversation, choose: boolean): Promise<void> {
    const [file] = choose ? await pickFiles('image/*', false) : [];
    if (choose && !file) return;
    await this.attempt(() => this.store.setImage(conversation.id, file ?? null));
  }

  protected imageUrl(conversation: Conversation): string {
    return `/api/chat/conversations/${conversation.id}/image?v=${conversation.imageVersion}`;
  }

  protected exportMenu(event: MouseEvent): void {
    this.ui.openMenu(event, [
      { label: 'Export as PDF', run: () => void this.exportChat('pdf') },
      { label: 'Export as text', run: () => void this.exportChat('txt') },
    ]);
  }

  protected async removeMember(conversation: Conversation, userId: string): Promise<void> {
    const leaving = userId === this.myId();
    const sure = await this.ui.confirm(
      leaving ? 'Leave this group?' : 'Remove this person from the group?',
      leaving ? 'You will no longer see its messages.' : '',
      leaving ? 'Leave' : 'Remove',
    );
    if (sure) await this.attempt(() => this.store.removeMember(conversation.id, userId));
  }
}
