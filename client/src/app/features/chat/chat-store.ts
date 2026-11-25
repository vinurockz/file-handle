import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { Ui } from '../../core/ui';
import {
  mergeHistory,
  sortConversations,
  upsertMessage,
  type Conversation,
  type Message,
} from './chat-model';

interface Thread {
  messages: Message[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
}

type ServerEvent =
  | { type: 'ready'; online: string[] }
  | { type: 'message' | 'message-updated'; message: Message }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'conversation-removed'; conversationId: string }
  | { type: 'typing'; conversationId: string; userId: string }
  | { type: 'presence'; userId: string; online: boolean }
  | { type: 'read'; conversationId: string; userId: string; seq: number };

const EMPTY: Thread = { messages: [], hasMore: false, loading: false, loaded: false };

/**
 * Chat state for the signed-in user, kept current over a self-reconnecting WebSocket.
 * Provided by the app shell, so presence and unread counts work on every page.
 */
@Injectable()
export class ChatStore {
  private readonly api = inject(Api);
  private readonly ui = inject(Ui);
  private readonly auth = inject(Auth);

  readonly conversations = signal<Conversation[]>([]);
  readonly loaded = signal(false);
  readonly connected = signal(false);
  readonly activeId = signal<string | null>(null);
  readonly active = computed(
    () => this.conversations().find((c) => c.id === this.activeId()) ?? null,
  );
  private readonly threads = signal<ReadonlyMap<string, Thread>>(new Map());
  readonly thread = computed(() => this.threads().get(this.activeId() ?? '') ?? EMPTY);
  /** Who is typing, as `conversationId:userId`. */
  readonly typing = signal<ReadonlySet<string>>(new Set());
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private stopped = false;
  private lastTypingSent = 0;
  private readonly readSent = new Map<string, number>();
  private listRequest = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.stopped = true;
      clearTimeout(this.retry);
      this.typingTimers.forEach((t) => clearTimeout(t));
      this.socket?.close();
    });
  }

  private get myId(): string {
    return this.auth.user()?.id ?? '';
  }

  start(): void {
    void this.loadConversations();
    this.connect();
  }

  async loadConversations(): Promise<void> {
    const request = ++this.listRequest;
    try {
      const list = await this.api.get<Conversation[]>('/chat/conversations');
      if (request !== this.listRequest) return;
      this.conversations.set(sortConversations(list));
      this.loaded.set(true);
    } catch (error) {
      this.ui.error(error);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    );
    this.socket = socket;
    socket.onopen = () => {
      const reconnect = this.attempts > 0;
      this.attempts = 0;
      this.connected.set(true);
      if (reconnect) this.resynchronise();
    };
    socket.onmessage = (event) => {
      try {
        this.handle(JSON.parse(String(event.data)) as ServerEvent);
      } catch (error) {
        console.warn('Ignored a malformed chat event', error);
      }
    };
    socket.onclose = (event) => {
      this.connected.set(false);
      if (this.stopped || event.code === 4001) return;
      this.attempts++;
      this.retry = setTimeout(() => this.connect(), Math.min(15_000, 500 * 2 ** this.attempts));
    };
  }

  /** Events may have been missed while offline, so reload from the server. */
  private resynchronise(): void {
    void this.loadConversations();
    const id = this.activeId();
    this.threads.set(new Map());
    if (id) void this.loadThread(id);
  }

  private handle(event: ServerEvent): void {
    switch (event.type) {
      case 'ready': {
        const online = new Set(event.online);
        this.conversations.update((list) =>
          list.map((c) => ({
            ...c,
            members: c.members.map((m) => ({
              ...m,
              online: m.id === this.myId || online.has(m.id),
            })),
          })),
        );
        break;
      }
      case 'message':
        this.receive(event.message);
        break;
      case 'message-updated':
        this.apply(event.message);
        break;
      case 'conversation':
        this.putConversation(event.conversation);
        break;
      case 'conversation-removed':
        this.drop(event.conversationId);
        break;
      case 'typing':
        this.showTyping(`${event.conversationId}:${event.userId}`);
        break;
      case 'presence':
        this.conversations.update((list) =>
          list.map((c) => ({
            ...c,
            members: c.members.map((m) =>
              m.id === event.userId ? { ...m, online: event.online } : m,
            ),
          })),
        );
        break;
      case 'read':
        this.conversations.update((list) =>
          list.map((c) =>
            c.id !== event.conversationId
              ? c
              : {
                  ...c,
                  unread:
                    event.userId === this.myId && event.seq >= (c.lastMessage?.seq ?? 0)
                      ? 0
                      : c.unread,
                  members: c.members.map((m) =>
                    m.id === event.userId ? { ...m, lastReadSeq: event.seq } : m,
                  ),
                },
          ),
        );
        break;
    }
  }

  private showTyping(key: string): void {
    clearTimeout(this.typingTimers.get(key));
    this.typing.update((set) => new Set(set).add(key));
    this.typingTimers.set(
      key,
      setTimeout(() => this.clearTyping(key), 3500),
    );
  }

  private clearTyping(key: string): void {
    this.typing.update((set) => {
      const next = new Set(set);
      next.delete(key);
      return next;
    });
  }

  private patchThread(id: string, change: (thread: Thread) => Thread): void {
    this.threads.update((map) => new Map(map).set(id, change(map.get(id) ?? EMPTY)));
  }

  /** A new message. The same one may arrive both from our request and from the socket. */
  receive(message: Message): void {
    this.clearTyping(`${message.conversationId}:${message.senderId}`);
    const conversation = this.conversations().find((c) => c.id === message.conversationId);
    if (this.threads().has(message.conversationId)) {
      this.patchThread(message.conversationId, (t) => ({
        ...t,
        messages: upsertMessage(t.messages, message),
      }));
    }
    if (!conversation) {
      void this.loadConversations();
      return;
    }
    if (message.seq <= (conversation.lastMessage?.seq ?? 0)) return;
    this.conversations.update((list) =>
      sortConversations(
        list.map((c) =>
          c.id === message.conversationId
            ? {
                ...c,
                lastMessage: message,
                updatedAt: message.createdAt,
                unread: message.senderId === this.myId ? 0 : c.unread + 1,
              }
            : c,
        ),
      ),
    );
  }

  private apply(message: Message): void {
    if (this.threads().has(message.conversationId)) {
      this.patchThread(message.conversationId, (t) => ({
        ...t,
        messages: t.messages
          .map((m) => (m.id === message.id ? message : m))
          // Quotes of a deleted or edited message must follow it.
          .map((m) =>
            m.replyTo?.id === message.id
              ? {
                  ...m,
                  replyTo: {
                    ...m.replyTo,
                    text: message.text.slice(0, 200),
                    deleted: message.deletedAt !== null,
                  },
                }
              : m,
          ),
      }));
    }
    this.conversations.update((list) =>
      list.map((c) => (c.lastMessage?.id === message.id ? { ...c, lastMessage: message } : c)),
    );
    // A deleted unread message changes the count, which only the server knows exactly.
    if (message.deletedAt) void this.loadConversations();
  }

  private putConversation(conversation: Conversation): void {
    this.conversations.update((list) =>
      sortConversations([...list.filter((c) => c.id !== conversation.id), conversation]),
    );
  }

  private drop(id: string): void {
    this.conversations.update((list) => list.filter((c) => c.id !== id));
    this.threads.update((map) => {
      const next = new Map(map);
      next.delete(id);
      return next;
    });
    if (this.activeId() === id) this.activeId.set(null);
  }

  open(id: string | null): void {
    this.activeId.set(id);
    if (id && !this.threads().get(id)?.loaded) void this.loadThread(id);
  }

  async loadThread(id: string, older = false): Promise<void> {
    const thread = this.threads().get(id) ?? EMPTY;
    if (thread.loading) return;
    const before = older ? thread.messages[0]?.seq : undefined;
    this.patchThread(id, (t) => ({ ...t, loading: true }));
    try {
      const page = await this.api.get<{ messages: Message[]; hasMore: boolean }>(
        `/chat/conversations/${id}/messages${before ? `?before=${before}` : ''}`,
      );
      this.patchThread(id, (t) => ({
        messages: mergeHistory(t.messages, page.messages),
        hasMore: page.hasMore,
        loading: false,
        loaded: true,
      }));
    } catch (error) {
      this.patchThread(id, (t) => ({ ...t, loading: false }));
      this.ui.error(error);
    }
  }

  async markRead(): Promise<void> {
    const conversation = this.active();
    const seq = this.thread().messages.at(-1)?.seq ?? 0;
    if (
      !conversation ||
      !seq ||
      !conversation.unread ||
      (this.readSent.get(conversation.id) ?? 0) >= seq
    )
      return;
    this.readSent.set(conversation.id, seq);
    this.conversations.update((list) =>
      list.map((c) => (c.id === conversation.id ? { ...c, unread: 0 } : c)),
    );
    try {
      await this.api.post(`/chat/conversations/${conversation.id}/read`, { seq });
    } catch {
      this.readSent.delete(conversation.id);
    }
  }

  sendTyping(): void {
    const id = this.activeId();
    if (
      !id ||
      this.socket?.readyState !== WebSocket.OPEN ||
      Date.now() - this.lastTypingSent < 2000
    )
      return;
    this.lastTypingSent = Date.now();
    this.socket.send(JSON.stringify({ type: 'typing', conversationId: id }));
  }

  async create(type: 'direct' | 'group', memberIds: string[], name: string): Promise<void> {
    const conversation = await this.api.post<Conversation>('/chat/conversations', {
      type,
      memberIds,
      name,
    });
    this.putConversation(conversation);
    this.open(conversation.id);
  }

  async send(
    conversationId: string,
    text: string,
    replyToId: string | null,
    fileIds: string[],
  ): Promise<void> {
    this.receive(
      await this.api.post<Message>(`/chat/conversations/${conversationId}/messages`, {
        text,
        replyToId,
        fileIds,
      }),
    );
  }

  async edit(message: Message, text: string): Promise<void> {
    this.apply(
      await this.api.put<Message>(
        `/chat/conversations/${message.conversationId}/messages/${message.id}`,
        { text },
      ),
    );
  }

  async remove(message: Message): Promise<void> {
    await this.api.delete(`/chat/conversations/${message.conversationId}/messages/${message.id}`);
    this.apply({ ...message, text: '', attachments: [], reactions: [], deletedAt: Date.now() });
  }

  async react(message: Message, emoji: string): Promise<void> {
    this.apply(
      await this.api.post<Message>(
        `/chat/conversations/${message.conversationId}/messages/${message.id}/reactions`,
        { emoji },
      ),
    );
  }

  async update(id: string, patch: { name?: string; description?: string }): Promise<void> {
    this.putConversation(await this.api.put<Conversation>(`/chat/conversations/${id}`, patch));
  }

  async setImage(id: string, image: File | null): Promise<void> {
    let updated: Conversation;
    if (image) {
      const form = new FormData();
      form.append('file', image, image.name);
      updated = await this.api.post<Conversation>(`/chat/conversations/${id}/image`, form);
    } else {
      updated = await this.api.send<Conversation>('delete', `/chat/conversations/${id}/image`);
    }
    this.putConversation(updated);
  }

  async addMembers(id: string, userIds: string[]): Promise<void> {
    this.putConversation(
      await this.api.post<Conversation>(`/chat/conversations/${id}/members`, { userIds }),
    );
  }

  async removeMember(id: string, userId: string): Promise<void> {
    await this.api.delete(`/chat/conversations/${id}/members/${userId}`);
    if (userId === this.myId) this.drop(id);
    else await this.loadConversations();
  }
}
