import { Injectable, signal } from '@angular/core';
import { errorMessage } from './api';
import type { MediaItem, MediaKind } from './media';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
}

export type DialogRequest =
  | {
      type: 'confirm';
      title: string;
      message: string;
      action: string;
      danger: boolean;
      resolve: (ok: boolean) => void;
    }
  | {
      type: 'prompt';
      title: string;
      value: string;
      action: string;
      resolve: (value: string | null) => void;
    }
  | { type: 'media'; kinds: MediaKind[]; multiple: boolean; resolve: (items: MediaItem[]) => void };

export interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
}

export interface Menu {
  x: number;
  y: number;
  items: MenuItem[];
  swatches?: { label: string; colors: string[]; current: string; pick: (color: string) => void };
}

@Injectable({ providedIn: 'root' })
export class Ui {
  readonly menu = signal<Menu | null>(null);

  /** Opens a context menu at the pointer, or beside the button when opened from the keyboard. */
  openMenu(event: MouseEvent, items: MenuItem[], swatches?: Menu['swatches']): void {
    event.preventDefault();
    event.stopPropagation();
    let { clientX: x, clientY: y } = event;
    if (!x && !y) {
      const box = (event.target as HTMLElement).getBoundingClientRect();
      x = box.left;
      y = box.bottom;
    }
    this.menu.set({ x, y, items, swatches });
  }

  readonly toasts = signal<Toast[]>([]);
  /** A stack, so a prompt opened on top of the media picker returns to it. */
  readonly dialogs = signal<DialogRequest[]>([]);
  private nextId = 1;

  toast(text: string, tone: Toast['tone'] = 'info'): void {
    if (this.toasts().some((t) => t.text === text)) return;
    const id = this.nextId++;
    this.toasts.update((list) => [...list.slice(-3), { id, text, tone }]);
    setTimeout(() => this.dismiss(id), tone === 'error' ? 7000 : 3500);
  }

  success(text: string): void {
    this.toast(text, 'success');
  }

  error(error: unknown): void {
    console.warn(error);
    this.toast(errorMessage(error), 'error');
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  confirm(title: string, message = '', action = 'Delete', danger = true): Promise<boolean> {
    return this.open<boolean>((resolve) => ({
      type: 'confirm',
      title,
      message,
      action,
      danger,
      resolve,
    }));
  }

  prompt(title: string, value = '', action = 'Save'): Promise<string | null> {
    return this.open<string | null>((resolve) => ({
      type: 'prompt',
      title,
      value,
      action,
      resolve,
    }));
  }

  pickMedia(kinds: MediaKind[], multiple = false): Promise<MediaItem[]> {
    return this.open<MediaItem[]>((resolve) => ({ type: 'media', kinds, multiple, resolve }));
  }

  /** Cancels everything, for example on sign-out. */
  closeAll(): void {
    this.menu.set(null);
    for (const dialog of this.dialogs()) {
      if (dialog.type === 'confirm') dialog.resolve(false);
      else if (dialog.type === 'prompt') dialog.resolve(null);
      else dialog.resolve([]);
    }
  }

  private open<T>(build: (resolve: (value: T) => void) => DialogRequest): Promise<T> {
    return new Promise<T>((done) => {
      const request: DialogRequest = build((value) => {
        this.dialogs.update((list) => list.filter((d) => d !== request));
        done(value);
      });
      this.dialogs.update((list) => [...list, request]);
    });
  }
}
