import { computed, signal } from '@angular/core';

const LIMIT = 100;
const COALESCE_MS = 700;

/**
 * Undo/redo over immutable snapshots.
 * `preview` shows intermediate drag states without recording them; `commitPreview` records one step.
 */
export class History<T> {
  private readonly past = signal<T[]>([]);
  private readonly future = signal<T[]>([]);
  private readonly current;
  private previewBase: { value: T } | null = null;
  private lastKey = '';
  private lastAt = 0;
  /** Increments on every recorded change; use it to detect unsaved work. */
  readonly revision = signal(0);

  readonly canUndo = computed(() => this.past().length > 0);
  readonly canRedo = computed(() => this.future().length > 0);

  constructor(initial: T) {
    this.current = signal(initial);
  }

  get value(): T {
    return this.current();
  }

  /** Records a change. Rapid commits sharing a `key` (slider ticks, typing) become a single step. */
  commit(next: T, key = ''): void {
    const base = this.previewBase ? this.previewBase.value : this.current();
    this.previewBase = null;
    if (next === base) {
      this.current.set(next);
      return;
    }
    const now = Date.now();
    const merge =
      key !== '' &&
      key === this.lastKey &&
      now - this.lastAt < COALESCE_MS &&
      this.past().length > 0;
    if (!merge) this.past.update((list) => [...list.slice(1 - LIMIT), base]);
    this.lastKey = key;
    this.lastAt = now;
    this.future.set([]);
    this.current.set(next);
    this.revision.update((r) => r + 1);
  }

  update(change: (value: T) => T, key = ''): void {
    this.commit(change(this.previewBase ? this.previewBase.value : this.current()), key);
  }

  preview(next: T): void {
    this.previewBase ??= { value: this.current() };
    this.current.set(next);
  }

  commitPreview(): void {
    if (this.previewBase) this.commit(this.current());
  }

  cancelPreview(): void {
    if (!this.previewBase) return;
    this.current.set(this.previewBase.value);
    this.previewBase = null;
  }

  undo(): void {
    this.cancelPreview();
    const previous = this.past().at(-1);
    if (previous === undefined) return;
    this.future.update((list) => [this.current(), ...list]);
    this.past.update((list) => list.slice(0, -1));
    this.current.set(previous);
    this.afterTravel();
  }

  redo(): void {
    this.cancelPreview();
    const [next, ...rest] = this.future();
    if (next === undefined) return;
    this.past.update((list) => [...list, this.current()]);
    this.future.set(rest);
    this.current.set(next);
    this.afterTravel();
  }

  reset(value: T): void {
    this.previewBase = null;
    this.lastKey = '';
    this.past.set([]);
    this.future.set([]);
    this.current.set(value);
    this.revision.set(0);
  }

  private afterTravel(): void {
    this.lastKey = '';
    this.revision.update((r) => r + 1);
  }
}

/** Standard Ctrl/Cmd+Z, Ctrl+Y and Ctrl+Shift+Z. Returns true when it handled the event. */
export function handleHistoryKey(event: KeyboardEvent, history: History<unknown>): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  const key = event.key.toLowerCase();
  if (key !== 'z' && key !== 'y') return false;
  event.preventDefault();
  if (key === 'y' || event.shiftKey) history.redo();
  else history.undo();
  return true;
}
