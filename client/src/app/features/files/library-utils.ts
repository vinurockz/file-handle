import type { Folder, MediaItem } from '../../core/media';

export interface FolderOption {
  id: string;
  label: string;
  depth: number;
}

/** Depth-first list of the folder tree, skipping `exclude` and everything under it. */
export function folderTree(folders: Folder[], exclude: string | null = null): FolderOption[] {
  const result: FolderOption[] = [];
  const walk = (parent: string | null, depth: number) => {
    const children = folders
      .filter((f) => (f.folderParentId ?? null) === parent && f.id !== exclude)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of children) {
      result.push({ id: folder.id, label: folder.name, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return result;
}

/** Ancestors from the root down to `id`, tolerant of broken or circular data. */
export function folderPath(folders: Folder[], id: string | null): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: Folder[] = [];
  const seen = new Set<string>();
  let cursor = id;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = byId.get(cursor);
    if (!folder) break;
    path.unshift(folder);
    cursor = folder.folderParentId;
  }
  return path;
}

export interface FolderSummary {
  count: number;
  /** Newest picture, else newest video, to show on the folder tile. */
  cover: MediaItem | null;
}

export function folderSummaries(folders: Folder[], items: MediaItem[]): Map<string, FolderSummary> {
  const result = new Map<string, FolderSummary>(
    folders.map((f) => [f.id, { count: 0, cover: null }]),
  );
  const rank = (m: MediaItem | null) => (m?.kind === 'image' ? 2 : m?.kind === 'video' ? 1 : 0);
  for (const item of items) {
    for (const folder of folderPath(folders, item.folderId)) {
      const summary = result.get(folder.id)!;
      summary.count++;
      const better =
        rank(item) > rank(summary.cover) ||
        (rank(item) > 0 &&
          rank(item) === rank(summary.cover) &&
          item.createdAt > summary.cover!.createdAt);
      if (better) summary.cover = item;
    }
  }
  return result;
}

export const COLOR_NAMES = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'brown',
  'white',
  'gray',
  'black',
] as const;
export type ColorName = (typeof COLOR_NAMES)[number];

/** Buckets an RGB colour into a named group for the picture colour filter. */
export function colorName(r: number, g: number, b: number): ColorName {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  if (lightness < 0.14) return 'black';
  if (lightness > 0.88) return 'white';
  if (saturation < 0.16) return 'gray';
  let hue: number;
  if (max === r / 255) hue = ((g - b) / 255 / delta + 6) % 6;
  else if (max === g / 255) hue = (b - r) / 255 / delta + 2;
  else hue = (r - g) / 255 / delta + 4;
  hue *= 60;
  if (hue < 15 || hue >= 345) return 'red';
  if (hue < 45) return lightness < 0.42 ? 'brown' : 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 165) return 'green';
  if (hue < 195) return 'teal';
  if (hue < 255) return 'blue';
  if (hue < 295) return 'purple';
  return 'pink';
}
