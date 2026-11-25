/** Drag and drop onto the website canvas: where a block would land, and putting it there. */
import { findBlock, insertAfter, insertIntoColumn, removeBlock } from './site';
import type { SiteBlock } from './types';

export const DRAG_NEW = 'application/x-studio-new-block';
export const DRAG_MOVE = 'application/x-studio-move-block';

export type DropTarget =
  | { kind: 'before' | 'after'; id: string }
  | { kind: 'column'; parentId: string; column: number }
  | { kind: 'end' };

/** Reads the drop position from the canvas element under the pointer. */
export function dropTargetAt(element: Element | null, pointerY: number): DropTarget {
  const block = element?.closest<HTMLElement>('[data-block-id]') ?? null;
  const column = element?.closest<HTMLElement>('[data-column]') ?? null;
  // Over a column's own empty space (not over a block inside it): drop into that column.
  if (column && (!block || block.contains(column))) {
    const [parentId = '', index = '0'] = (column.dataset['column'] ?? '').split('|');
    return { kind: 'column', parentId, column: Number(index) };
  }
  if (!block) return { kind: 'end' };
  const box = block.getBoundingClientRect();
  return {
    kind: pointerY > box.top + box.height / 2 ? 'after' : 'before',
    id: block.dataset['blockId']!,
  };
}

function insertBefore(blocks: SiteBlock[], id: string, added: SiteBlock): SiteBlock[] {
  // Insert after, then swap the two, which works at any depth.
  const placed = insertAfter(blocks, id, added);
  const swap = (list: SiteBlock[]): SiteBlock[] => {
    const at = list.findIndex((b) => b.id === added.id);
    if (at > 0 && list[at - 1]!.id === id) {
      const next = [...list];
      [next[at - 1], next[at]] = [next[at]!, next[at - 1]!];
      return next;
    }
    return list.map((b) => (b.columns ? { ...b, columns: b.columns.map(swap) } : b));
  };
  return swap(placed);
}

export function placeBlock(blocks: SiteBlock[], block: SiteBlock, target: DropTarget): SiteBlock[] {
  if (target.kind === 'end') return [...blocks, block];
  if (target.kind === 'column')
    return insertIntoColumn(blocks, target.parentId, target.column, block);
  return target.kind === 'before'
    ? insertBefore(blocks, target.id, block)
    : insertAfter(blocks, target.id, block);
}

/** Moves an existing block. Returns the same list when the move would be impossible or pointless. */
export function moveBlock(blocks: SiteBlock[], id: string, target: DropTarget): SiteBlock[] {
  const moving = findBlock(blocks, id);
  if (!moving) return blocks;
  const anchor =
    target.kind === 'column' ? target.parentId : target.kind === 'end' ? null : target.id;
  // A block cannot be dropped onto itself or anything inside it.
  if (anchor && findBlock([moving], anchor)) return blocks;
  return placeBlock(removeBlock(blocks, id), moving, target);
}

type TabItem = { key?: string };

/** Keeps each tab's blocks with its tab when tabs are reordered, added or removed. */
export function syncTabs(block: SiteBlock, items: TabItem[]): SiteBlock {
  const old = (block.props['items'] as TabItem[] | undefined) ?? [];
  const columns = items.map((item, index) => {
    const from = item.key ? old.findIndex((o) => o.key === item.key) : index;
    return block.columns?.[from] ?? [];
  });
  return { ...block, props: { ...block.props, items }, columns };
}
