import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { Api } from './api';
import { Ui } from './ui';

export interface Doc {
  id: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type NewDoc<T extends Doc> = Partial<Omit<T, 'id' | 'createdAt' | 'updatedAt'>>;

interface Queue {
  pending: Record<string, unknown> | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  chain: Promise<boolean>;
}

/** Tracks every store with unsaved work, so sign-out and tab close can wait for or warn about it. */
@Injectable({ providedIn: 'root' })
export class SaveRegistry {
  private readonly stores = signal<ReadonlySet<CollectionStore<Doc>>>(new Set());
  readonly busy = computed(() => [...this.stores()].some((s) => s.status() !== 'saved'));
  readonly failed = computed(() => [...this.stores()].some((s) => s.status() === 'error'));

  add(store: CollectionStore<Doc>): void {
    this.stores.update((set) => new Set(set).add(store));
  }

  release(store: CollectionStore<Doc>): void {
    this.stores.update((set) => {
      const next = new Set(set);
      next.delete(store);
      return next;
    });
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.stores()].map((s) => s.flushAll()));
  }

  /** Forgets everything after sign-out, so one user's unsaved state never reaches the next. */
  clear(): void {
    this.stores.set(new Set());
  }
}

/**
 * Server documents with immediate local updates and debounced saves.
 * Saves for one document are sent strictly in order, so an older request can never overwrite a newer one,
 * and a failed save is kept and retried together with the next change.
 */
export class CollectionStore<T extends Doc> {
  readonly items = signal<T[]>([]);
  readonly loaded = signal(false);
  private readonly queues = new Map<string, Queue>();
  private readonly pendingCount = signal(0);
  private readonly failures = signal<ReadonlySet<string>>(new Set());
  readonly status = computed<'saved' | 'saving' | 'error'>(() =>
    this.failures().size ? 'error' : this.pendingCount() ? 'saving' : 'saved',
  );
  private loadToken = 0;

  private readonly api: Api;
  private readonly ui: Ui;
  readonly name: string;

  constructor(api: Api, ui: Ui, name: string) {
    this.api = api;
    this.ui = ui;
    this.name = name;
  }

  async load(parentId?: string): Promise<void> {
    const token = ++this.loadToken;
    this.loaded.set(false);
    try {
      const query = parentId ? `?parentId=${encodeURIComponent(parentId)}` : '';
      const items = await this.api.get<T[]>(`/docs/${this.name}${query}`);
      // A slower, older request must not replace the result of a newer one.
      if (token !== this.loadToken) return;
      this.items.set(items);
      this.loaded.set(true);
    } catch (error) {
      if (token === this.loadToken) this.ui.error(error);
    }
  }

  byId(id: string | null | undefined): T | undefined {
    return this.items().find((item) => item.id === id);
  }

  async create(data: NewDoc<T>): Promise<T> {
    const created = await this.api.post<T>(`/docs/${this.name}`, data);
    this.items.update((list) => [...list, created]);
    return created;
  }

  /** Applies a change locally at once and saves it after `delay` ms of quiet. */
  patch(id: string, change: Partial<T>, delay = 600): void {
    if (!this.byId(id)) return;
    this.items.update((list) =>
      list.map((d) => (d.id === id ? { ...d, ...change, updatedAt: Date.now() } : d)),
    );
    const queue = this.queueFor(id);
    queue.pending = { ...queue.pending, ...(change as Record<string, unknown>) };
    clearTimeout(queue.timer);
    queue.timer = setTimeout(() => void this.flush(id), delay);
    this.recount();
  }

  flush(id: string): Promise<boolean> {
    const queue = this.queues.get(id);
    if (!queue) return Promise.resolve(true);
    clearTimeout(queue.timer);
    queue.timer = undefined;
    queue.chain = queue.chain.then(async () => {
      const body = queue.pending;
      if (!body) return !this.failures().has(id);
      queue.pending = null;
      this.inFlight.add(id);
      try {
        await this.api.put(`/docs/${this.name}/${id}`, body);
        this.setFailed(id, false);
        return true;
      } catch (error) {
        // Keep the unsaved fields; anything changed since then wins over them.
        queue.pending = { ...body, ...(queue.pending as Record<string, unknown> | null) };
        this.setFailed(id, true);
        this.ui.error(error);
        return false;
      } finally {
        this.inFlight.delete(id);
        this.recount();
      }
    });
    return queue.chain;
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.queues.keys()].map((id) => this.flush(id)));
  }

  async remove(id: string): Promise<void> {
    const queue = this.queues.get(id);
    if (queue) {
      clearTimeout(queue.timer);
      queue.pending = null;
      await queue.chain;
    }
    await this.api.delete(`/docs/${this.name}/${id}`);
    this.queues.delete(id);
    this.setFailed(id, false);
    this.items.update((list) => list.filter((d) => d.id !== id));
    this.recount();
  }

  /** Reorders the given documents among themselves, leaving the rest where they are. */
  async reorder(ids: string[]): Promise<void> {
    const before = this.items();
    const byId = new Map(before.map((d) => [d.id, d]));
    const wanted = new Set(ids);
    let next = 0;
    this.items.set(before.map((d) => (wanted.has(d.id) ? byId.get(ids[next++]!)! : d)));
    try {
      await this.api.post(`/docs/${this.name}/reorder`, { ids: this.items().map((d) => d.id) });
    } catch (error) {
      this.items.set(before);
      this.ui.error(error);
    }
  }

  private readonly inFlight = new Set<string>();

  private queueFor(id: string): Queue {
    let queue = this.queues.get(id);
    if (!queue) {
      queue = { pending: null, timer: undefined, chain: Promise.resolve(true) };
      this.queues.set(id, queue);
    }
    return queue;
  }

  private recount(): void {
    let count = 0;
    for (const [id, queue] of this.queues) if (queue.pending || this.inFlight.has(id)) count++;
    this.pendingCount.set(count);
  }

  private setFailed(id: string, failed: boolean): void {
    if (this.failures().has(id) === failed) return;
    const next = new Set(this.failures());
    if (failed) next.add(id);
    else next.delete(id);
    this.failures.set(next);
  }
}

/** A store tied to the calling component: pending changes are saved when it is destroyed. */
export function injectCollection<T extends Doc>(name: string): CollectionStore<T> {
  const store = new CollectionStore<T>(inject(Api), inject(Ui), name);
  const registry = inject(SaveRegistry);
  const generic = store as unknown as CollectionStore<Doc>;
  registry.add(generic);
  inject(DestroyRef).onDestroy(() => {
    void store.flushAll().then(() => {
      // A store that failed to save stays registered so the user is still warned about it.
      if (store.status() === 'saved') registry.release(generic);
    });
  });
  return store;
}
