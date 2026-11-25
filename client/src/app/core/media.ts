import { computed, inject, Injectable, signal } from '@angular/core';
import { Api } from './api';
import { Ui } from './ui';
import type { Doc } from './collection';

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf';

export interface MediaItem {
  id: string;
  folderId: string | null;
  kind: MediaKind;
  title: string;
  mime: string;
  size: number;
  createdAt: number;
  updatedAt: number;
}

export interface Folder extends Doc {
  name: string;
  color: string;
  folderParentId: string | null;
}

export const mediaUrl = (id: string | null | undefined): string =>
  id ? `/api/media/${id}/file` : '';

export const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
};

export const mediaFilename = (item: MediaItem): string =>
  `${item.title}.${EXTENSIONS[item.mime] ?? 'bin'}`;

/** The workspace's file library, shared by every module. */
@Injectable({ providedIn: 'root' })
export class MediaLibrary {
  private readonly api = inject(Api);
  private readonly ui = inject(Ui);
  readonly items = signal<MediaItem[]>([]);
  readonly folders = signal<Folder[]>([]);
  readonly loaded = signal(false);
  readonly uploading = signal(0);
  private readonly index = computed(() => new Map(this.items().map((m) => [m.id, m])));
  private request: Promise<void> | null = null;
  private generation = 0;

  byId(id: string | null | undefined): MediaItem | undefined {
    return id ? this.index().get(id) : undefined;
  }

  /** Drops everything when the workspace changes. */
  reset(): void {
    this.generation++;
    this.request = null;
    this.items.set([]);
    this.folders.set([]);
    this.loaded.set(false);
  }

  /** Fetches the library; concurrent callers share one request. */
  load(): Promise<void> {
    if (this.request) return this.request;
    const generation = this.generation;
    const request = Promise.all([
      this.api.get<MediaItem[]>('/media'),
      this.api.get<Folder[]>('/docs/folders'),
    ])
      .then(([items, folders]) => {
        if (generation !== this.generation) return;
        this.items.set(items);
        this.folders.set(folders);
        this.loaded.set(true);
      })
      .catch((error: unknown) => {
        if (generation === this.generation) this.ui.error(error);
      })
      .finally(() => {
        if (this.request === request) this.request = null;
      });
    this.request = request;
    return request;
  }

  async upload(file: Blob, filename: string, folderId: string | null = null): Promise<MediaItem> {
    const generation = this.generation;
    const form = new FormData();
    form.append('file', file, filename);
    if (folderId) form.append('folderId', folderId);
    this.uploading.update((n) => n + 1);
    try {
      const item = await this.api.post<MediaItem>('/media', form);
      if (generation === this.generation) this.items.update((list) => [item, ...list]);
      return item;
    } finally {
      this.uploading.update((n) => n - 1);
    }
  }

  /** Uploads several files one at a time, reporting failures without stopping the rest. */
  async uploadMany(files: File[], folderId: string | null = null): Promise<MediaItem[]> {
    const added: MediaItem[] = [];
    for (const file of files) {
      try {
        added.push(await this.upload(file, file.name, folderId));
      } catch (error) {
        this.ui.error(error);
      }
    }
    return added;
  }

  /** Refreshes after the server created a file itself, such as a video export. */
  async refresh(): Promise<void> {
    this.request = null;
    await this.load();
  }

  async update(id: string, patch: Partial<Pick<MediaItem, 'title' | 'folderId'>>): Promise<void> {
    const item = await this.api.put<MediaItem>(`/media/${id}`, patch);
    this.items.update((list) => list.map((m) => (m.id === id ? item : m)));
  }

  async remove(id: string): Promise<void> {
    await this.api.delete(`/media/${id}`);
    this.items.update((list) => list.filter((m) => m.id !== id));
  }

  async createFolder(name: string, folderParentId: string | null, color = ''): Promise<Folder> {
    const folder = await this.api.post<Folder>('/docs/folders', { name, folderParentId, color });
    this.folders.update((list) => [...list, folder]);
    return folder;
  }

  async updateFolder(id: string, patch: Partial<Folder>): Promise<void> {
    const folder = await this.api.put<Folder>(`/docs/folders/${id}`, patch);
    this.folders.update((list) => list.map((f) => (f.id === id ? folder : f)));
  }

  /** The server moves a deleted folder's contents up a level, so reload both lists. */
  async removeFolder(id: string): Promise<void> {
    await this.api.delete(`/docs/folders/${id}`);
    await this.refresh();
  }

  /** Finds or creates a top-level folder such as "Chat uploads". */
  async ensureFolder(name: string): Promise<string> {
    if (!this.loaded()) await this.load();
    const existing = this.folders().find((f) => !f.folderParentId && f.name === name);
    return existing ? existing.id : (await this.createFolder(name, null)).id;
  }
}
