import { Component, computed, effect, inject, OnInit, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import {
  EXTENSIONS,
  MediaLibrary,
  mediaFilename,
  mediaUrl,
  type Folder,
  type MediaItem,
  type MediaKind,
} from '../../core/media';
import { Ui } from '../../core/ui';
import {
  downloadBlob,
  formatBytes,
  loadImage,
  pickFiles,
  safeFilename,
  uniqueName,
} from '../../core/util';
import { Thumb } from '../../shared/overlays';
import { Modal } from '../../shared/widgets';
import {
  COLOR_NAMES,
  colorName,
  folderPath,
  folderSummaries,
  folderTree,
  type ColorName,
} from './library-utils';
import { Viewer } from './viewer';

type Sort = 'newest' | 'name' | 'size';
const FOLDER_COLORS = ['', '#ef4444', '#f59e0b', '#10b981', '#0ea5e9', '#6366f1', '#ec4899'];
const MAX_ZIP_ENTRIES = 1000;
const MEDIA_DRAG = 'application/x-studio-media';

@Component({
  selector: 'app-files',
  imports: [Thumb, Modal, Viewer],
  host: {
    class: 'page',
    '(dragover)': 'allowDrop($event)',
    '(drop)': 'dropFiles($event, folderId())',
  },
  templateUrl: './files.html',
  styles: `
    .folder {
      flex-direction: row;
      align-items: center;
    }
    .cover {
      width: 52px;
      height: 52px;
      flex: none;
      object-fit: cover;
      border-radius: 6px;
      background: var(--surface-2);
      display: grid;
      place-items: center;
      font-size: 1.5rem;
    }
    .folder .tile-open {
      min-height: 0;
      flex: 1;
      min-width: 0;
    }
    .card-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 4px;
    }
    .card-check {
      position: absolute;
      top: 10px;
      left: 10px;
      z-index: 2;
      width: 18px;
      height: 18px;
    }
    .open-card {
      border: 0;
      padding: 0;
      background: none;
      cursor: pointer;
      display: block;
      width: 100%;
    }
    .selection-bar {
      position: sticky;
      top: 0;
      z-index: 5;
      background: var(--accent-soft);
      padding: 0.5rem;
      border-radius: 8px;
    }
    .crumbs {
      flex: 1;
      flex-wrap: wrap;
      gap: 0.15rem;
    }
    .tree-pick {
      justify-content: flex-start;
      width: 100%;
    }
  `,
})
export class Files implements OnInit {
  protected readonly library = inject(MediaLibrary);
  private readonly ui = inject(Ui);
  private readonly router = inject(Router);
  /** File count and cover picture for each folder, including what is inside its subfolders. */
  protected readonly summaries = computed(() =>
    folderSummaries(this.library.folders(), this.library.items()),
  );
  protected readonly colorCounts = computed(() => {
    const counts = new Map<ColorName, number>();
    for (const item of this.scoped()) {
      const color = this.colors().get(item.id);
      if (color) counts.set(color, (counts.get(color) ?? 0) + 1);
    }
    return counts;
  });

  protected readonly folderId = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly kind = signal<MediaKind | 'all'>('all');
  protected readonly sort = signal<Sort>('newest');
  protected readonly view = signal<'grid' | 'list'>(
    localStorage.getItem('studio:view') === 'list' ? 'list' : 'grid',
  );
  protected readonly colorFilter = signal<ColorName | null>(null);
  protected readonly colors = signal<ReadonlyMap<string, ColorName>>(new Map());
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly viewing = signal<string | null>(null);
  /** Ids waiting for a destination in the "Move to" dialog. */
  protected readonly moving = signal<{ media: string[]; folder: string | null } | null>(null);
  protected readonly working = signal('');

  protected readonly url = mediaUrl;
  protected readonly bytes = formatBytes;
  protected readonly dateOf = (time: number) => new Date(time).toLocaleDateString();
  protected readonly newSelection = () => new Set<string>();
  protected readonly kinds: (MediaKind | 'all')[] = ['all', 'image', 'video', 'audio', 'pdf'];
  protected readonly folderColors = FOLDER_COLORS;
  protected readonly path = computed(() => folderPath(this.library.folders(), this.folderId()));
  protected readonly searching = computed(() => this.query().trim() !== '');

  protected readonly subfolders = computed(() => {
    const text = this.query().trim().toLowerCase();
    return this.library
      .folders()
      .filter((f) =>
        text ? f.name.toLowerCase().includes(text) : f.folderParentId === this.folderId(),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  /** Files in view before the colour filter, so the filter only offers colours that exist here. */
  private readonly scoped = computed(() => {
    const text = this.query().trim().toLowerCase();
    const kind = this.kind();
    return this.library
      .items()
      .filter((m) => (text ? m.title.toLowerCase().includes(text) : m.folderId === this.folderId()))
      .filter((m) => kind === 'all' || m.kind === kind);
  });

  protected readonly presentColors = computed(() => {
    const found = new Set(this.scoped().map((m) => this.colors().get(m.id)));
    return COLOR_NAMES.filter((c) => found.has(c));
  });

  protected readonly visible = computed(() => {
    const color = this.colorFilter();
    const sort = this.sort();
    return this.scoped()
      .filter((m) => !color || this.colors().get(m.id) === color)
      .sort((a, b) =>
        sort === 'name'
          ? a.title.localeCompare(b.title)
          : sort === 'size'
            ? b.size - a.size
            : b.createdAt - a.createdAt,
      );
  });

  private readonly sampled = new Set<string>();

  constructor() {
    effect(() => {
      const images = this.scoped().filter((m) => m.kind === 'image');
      untracked(() => void this.sampleColors(images));
    });
    // A folder deleted elsewhere must not leave the view stranded inside it.
    effect(() => {
      const id = this.folderId();
      if (id && this.library.loaded() && !this.library.folders().some((f) => f.id === id))
        this.folderId.set(null);
    });
  }

  ngOnInit(): void {
    void this.library.refresh();
  }

  private async sampleColors(images: MediaItem[]): Promise<void> {
    const todo = images.filter((m) => !this.sampled.has(m.id));
    todo.forEach((m) => this.sampled.add(m.id));
    for (const item of todo) {
      try {
        const image = await loadImage(mediaUrl(item.id));
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 12;
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        context.drawImage(image, 0, 0, 12, 12);
        const data = context.getImageData(0, 0, 12, 12).data;
        const votes = new Map<ColorName, number>();
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3]! < 128) continue;
          const name = colorName(data[i]!, data[i + 1]!, data[i + 2]!);
          votes.set(name, (votes.get(name) ?? 0) + 1);
        }
        const best = [...votes].sort((a, b) => b[1] - a[1])[0];
        if (best) this.colors.update((map) => new Map(map).set(item.id, best[0]));
      } catch {
        // An unreadable image simply has no colour tag.
      }
    }
  }

  protected openFolder(id: string | null): void {
    this.folderId.set(id);
    this.query.set('');
    this.colorFilter.set(null);
    this.selected.set(new Set());
  }

  protected setView(view: 'grid' | 'list'): void {
    this.view.set(view);
    localStorage.setItem('studio:view', view);
  }

  protected toggle(id: string): void {
    this.selected.update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected selectAll(): void {
    this.selected.set(new Set(this.visible().map((m) => m.id)));
  }

  private chosen(): MediaItem[] {
    return this.library.items().filter((m) => this.selected().has(m.id));
  }

  private async attempt(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.ui.error(error);
    } finally {
      this.working.set('');
    }
  }

  protected async upload(): Promise<void> {
    const files = await pickFiles('image/*,video/*,audio/*,application/pdf,.mkv,.avi,.mov');
    const added = await this.library.uploadMany(files, this.folderId());
    if (added.length) this.ui.success(`Added ${added.length} file${added.length === 1 ? '' : 's'}`);
  }

  protected async newFolder(): Promise<void> {
    const name = await this.ui.prompt('New folder name', '', 'Create');
    if (name) await this.attempt(() => this.library.createFolder(name, this.folderId()));
  }

  protected async renameFolder(folder: Folder): Promise<void> {
    const name = await this.ui.prompt('Rename folder', folder.name);
    if (name) await this.attempt(() => this.library.updateFolder(folder.id, { name }));
  }

  protected fileMenu(event: MouseEvent, item: MediaItem): void {
    const editor = { image: '/image-editor', video: '/video-editor', pdf: '/pdf', audio: '' }[
      item.kind
    ];
    this.ui.openMenu(event, [
      { label: 'Open', run: () => this.viewing.set(item.id) },
      ...(editor
        ? [
            {
              label: 'Edit',
              run: () => void this.router.navigate([editor], { queryParams: { media: item.id } }),
            },
          ]
        : []),
      { label: 'Download', run: () => this.download(item) },
      { label: 'Rename', run: () => void this.rename(item) },
      { label: 'Move to…', run: () => this.moving.set({ media: [item.id], folder: null }) },
      { label: 'Delete', run: () => void this.remove([item]), danger: true },
    ]);
  }

  protected folderMenu(event: MouseEvent, folder: Folder): void {
    this.ui.openMenu(
      event,
      [
        { label: 'Open', run: () => this.openFolder(folder.id) },
        { label: 'Download ZIP', run: () => void this.exportFolder(folder.id) },
        { label: 'Rename', run: () => void this.renameFolder(folder) },
        { label: 'Move to…', run: () => this.moving.set({ media: [], folder: folder.id }) },
        { label: 'Delete folder', run: () => void this.deleteFolder(folder), danger: true },
      ],
      {
        label: 'Folder colour',
        colors: FOLDER_COLORS,
        current: folder.color,
        pick: (color) => void this.attempt(() => this.library.updateFolder(folder.id, { color })),
      },
    );
  }

  private download(item: MediaItem): void {
    const anchor = document.createElement('a');
    anchor.href = `${mediaUrl(item.id)}?download=1`;
    anchor.download = mediaFilename(item);
    anchor.click();
  }

  protected async moveToNewFolder(): Promise<void> {
    const request = this.moving();
    if (!request) return;
    const name = await this.ui.prompt('New folder name', '', 'Create and move');
    if (!name) return;
    await this.attempt(async () => {
      const folder = await this.library.createFolder(name, this.folderId());
      await this.moveTo(folder.id);
    });
  }

  protected async deleteFolder(folder: Folder): Promise<void> {
    const sure = await this.ui.confirm(
      `Delete folder “${folder.name}”?`,
      'Its files and subfolders are not deleted. They move up one level.',
    );
    if (sure) await this.attempt(() => this.library.removeFolder(folder.id));
  }

  protected async rename(item: MediaItem): Promise<void> {
    const title = await this.ui.prompt('Rename file', item.title);
    if (title) await this.attempt(() => this.library.update(item.id, { title }));
  }

  protected async remove(items: MediaItem[]): Promise<void> {
    const label = items.length === 1 ? `“${items[0]!.title}”` : `${items.length} files`;
    const sure = await this.ui.confirm(
      `Delete ${label}?`,
      'This cannot be undone. Projects that use these files will show them as missing.',
    );
    if (!sure) return;
    await this.attempt(async () => {
      for (const item of items) await this.library.remove(item.id);
      this.selected.set(new Set());
    });
  }

  protected removeSelected(): void {
    void this.remove(this.chosen());
  }

  protected moveSelected(): void {
    this.moving.set({ media: [...this.selected()], folder: null });
  }

  protected moveTargets() {
    return folderTree(this.library.folders(), this.moving()?.folder ?? null);
  }

  protected async moveTo(target: string | null): Promise<void> {
    const request = this.moving();
    this.moving.set(null);
    if (!request) return;
    await this.attempt(async () => {
      if (request.folder)
        await this.library.updateFolder(request.folder, { folderParentId: target });
      for (const id of request.media) await this.library.update(id, { folderId: target });
      this.selected.set(new Set());
    });
  }

  // --- Drag and drop --------------------------------------------------------
  protected dragStart(event: DragEvent, item: MediaItem): void {
    const ids = this.selected().has(item.id) ? [...this.selected()] : [item.id];
    event.dataTransfer?.setData(MEDIA_DRAG, JSON.stringify(ids));
  }

  protected allowDrop(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? [];
    if (types.includes('Files') || types.includes(MEDIA_DRAG)) event.preventDefault();
  }

  protected async dropFiles(event: DragEvent, target: string | null): Promise<void> {
    const data = event.dataTransfer;
    if (!data) return;
    const dragged = data.getData(MEDIA_DRAG);
    const files = Array.from(data.files);
    if (!dragged && !files.length) return;
    event.preventDefault();
    event.stopPropagation();
    if (dragged) {
      await this.attempt(async () => {
        for (const id of JSON.parse(dragged) as string[]) {
          if (this.library.byId(id) && this.library.byId(id)!.folderId !== target) {
            await this.library.update(id, { folderId: target });
          }
        }
        this.selected.set(new Set());
      });
    } else {
      await this.library.uploadMany(files, target);
    }
  }

  // --- ZIP ------------------------------------------------------------------
  private async zip(
    entries: { path: string; item: MediaItem }[],
    emptyFolders: string[],
    name: string,
  ): Promise<void> {
    const { default: JSZip } = await import('jszip');
    const archive = new JSZip();
    const used = new Set<string>();
    emptyFolders.forEach((folder) => archive.folder(folder));
    for (const [index, entry] of entries.entries()) {
      this.working.set(`Zipping ${index + 1} of ${entries.length}…`);
      const response = await fetch(mediaUrl(entry.item.id));
      if (!response.ok) throw new Error(`Could not read “${entry.item.title}”`);
      archive.file(uniqueName(entry.path, used), await response.blob());
    }
    this.working.set('Building archive…');
    downloadBlob(await archive.generateAsync({ type: 'blob' }), `${name}.zip`);
  }

  protected async downloadSelected(): Promise<void> {
    const entries = this.chosen().map((item) => ({
      item,
      path: safeFilename(mediaFilename(item)),
    }));
    await this.attempt(() => this.zip(entries, [], 'studio-files'));
  }

  /** Zips the current folder, or the whole library from the top level, keeping the folder tree. */
  protected async exportFolder(root = this.folderId()): Promise<void> {
    const folders = this.library.folders();
    const relative = (id: string | null): string | null => {
      const chain = folderPath(folders, id);
      const start = root ? chain.findIndex((f) => f.id === root) : -1;
      if (root && start < 0) return null;
      return chain
        .slice(start + 1)
        .map((f) => safeFilename(f.name))
        .join('/');
    };
    const entries: { path: string; item: MediaItem }[] = [];
    for (const item of this.library.items()) {
      const dir = item.folderId === root ? '' : relative(item.folderId);
      if (dir === null || (root && !item.folderId)) continue;
      entries.push({ item, path: (dir ? `${dir}/` : '') + safeFilename(mediaFilename(item)) });
    }
    const emptyFolders = folders.map((f) => relative(f.id)).filter((p): p is string => !!p);
    if (!entries.length) {
      this.ui.toast('There are no files to export here');
      return;
    }
    const name = folders.find((f) => f.id === root)?.name ?? 'studio-backup';
    await this.attempt(() => this.zip(entries, emptyFolders, safeFilename(name)));
  }

  protected async importZip(): Promise<void> {
    const [file] = await pickFiles('.zip,application/zip', false);
    if (!file) return;
    await this.attempt(async () => {
      const { default: JSZip } = await import('jszip');
      this.working.set('Reading archive…');
      const archive = await JSZip.loadAsync(file);
      const supported = new Set(Object.values(EXTENSIONS).concat('jpeg', 'mkv'));
      const entries = Object.values(archive.files).filter(
        (e) =>
          !e.dir &&
          !e.name.startsWith('__MACOSX/') &&
          supported.has(e.name.split('.').pop()!.toLowerCase()),
      );
      if (!entries.length) throw new Error('No supported files were found in that ZIP');
      if (entries.length > MAX_ZIP_ENTRIES)
        throw new Error(`A ZIP can hold at most ${MAX_ZIP_ENTRIES} files`);
      const base = this.folderId();
      const created = new Map<string, string | null>([['', base]]);
      const ensure = async (segments: string[]): Promise<string | null> => {
        let parent = base;
        let key = '';
        for (const segment of segments) {
          key += `/${segment}`;
          if (!created.has(key)) {
            const found = this.library
              .folders()
              .find((f) => f.folderParentId === parent && f.name === segment);
            created.set(
              key,
              found?.id ?? (await this.library.createFolder(segment.slice(0, 200), parent)).id,
            );
          }
          parent = created.get(key)!;
        }
        return parent;
      };
      let added = 0;
      let skipped = 0;
      for (const [index, entry] of entries.entries()) {
        this.working.set(`Importing ${index + 1} of ${entries.length}…`);
        const segments = entry.name.split('/').filter((s) => s && s !== '.' && s !== '..');
        const filename = segments.pop();
        if (!filename) continue;
        try {
          const folder = await ensure(segments);
          const title = filename.replace(/\.[^.]+$/, '');
          // Restoring a backup over an existing library must not create duplicates.
          if (this.library.items().some((m) => m.folderId === folder && m.title === title)) {
            skipped++;
            continue;
          }
          await this.library.upload(await entry.async('blob'), filename, folder);
          added++;
        } catch (error) {
          this.ui.error(error);
          skipped++;
        }
      }
      this.ui.success(
        `Imported ${added} file${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}`,
      );
    });
  }
}
