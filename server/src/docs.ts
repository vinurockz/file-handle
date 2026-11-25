import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Db } from './db.ts';
import { HttpError, notFound, param, parse, workspaceOf } from './http.ts';
import { COLLECTIONS, type CollectionRule } from './schemas.ts';

export interface DocRow {
  id: string;
  parentId: string | null;
  position: number;
  data: string;
  createdAt: number;
  updatedAt: number;
}

export type Doc = Record<string, unknown> & {
  id: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
};

const COLUMNS = 'id, parentId, position, data, createdAt, updatedAt';

export function toDoc(row: DocRow): Doc {
  return {
    ...(JSON.parse(row.data) as Record<string, unknown>),
    id: row.id,
    parentId: row.parentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listDocs(
  db: Db,
  workspaceId: string,
  collection: string,
  parentId?: string,
): Doc[] {
  const rows =
    parentId === undefined
      ? db.all<DocRow>(
          `SELECT ${COLUMNS} FROM docs WHERE workspaceId = ? AND collection = ? ORDER BY position, createdAt`,
          workspaceId,
          collection,
        )
      : db.all<DocRow>(
          `SELECT ${COLUMNS} FROM docs WHERE workspaceId = ? AND collection = ? AND parentId = ?
           ORDER BY position, createdAt`,
          workspaceId,
          collection,
          parentId,
        );
  return rows.map(toDoc);
}

export function findDoc(
  db: Db,
  workspaceId: string,
  collection: string,
  id: string,
): Doc | undefined {
  const row = db.get<DocRow>(
    `SELECT ${COLUMNS} FROM docs WHERE id = ? AND workspaceId = ? AND collection = ?`,
    id,
    workspaceId,
    collection,
  );
  return row && toDoc(row);
}

const ruleFor = (name: string): CollectionRule => {
  if (!Object.hasOwn(COLLECTIONS, name)) throw notFound('Collection');
  return COLLECTIONS[name]!;
};

function assertParent(
  db: Db,
  workspaceId: string,
  rule: CollectionRule,
  parentId: unknown,
): string | null {
  if (!rule.parent) return null;
  if (typeof parentId !== 'string' || !findDoc(db, workspaceId, rule.parent, parentId)) {
    throw new HttpError(400, 'A valid parentId is required');
  }
  return parentId;
}

const nextPosition = (db: Db, workspaceId: string, collection: string) =>
  db.get<{ p: number }>(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM docs WHERE workspaceId = ? AND collection = ?',
    workspaceId,
    collection,
  )!.p;

/** Rules that need to look at other rows. `id` is null when creating. */
function checkInvariants(
  db: Db,
  workspaceId: string,
  collection: string,
  data: Record<string, unknown>,
  id: string | null,
  parentId: string | null,
): void {
  if (collection === 'bookPages' && id === null && parentId) {
    const limit = findDoc(db, workspaceId, 'books', parentId)?.['pageLimit'];
    if (
      typeof limit === 'number' &&
      listDocs(db, workspaceId, collection, parentId).length >= limit
    ) {
      throw new HttpError(400, `This book is limited to ${limit} pages`);
    }
  }
  if (collection === 'customEndpoints') {
    const clash = listDocs(db, workspaceId, collection).some(
      (other) =>
        other.id !== id && other['method'] === data['method'] && other['path'] === data['path'],
    );
    if (clash) throw new HttpError(409, 'An endpoint with this method and path already exists');
  }
  if (collection === 'folders') {
    // Walk up from the proposed parent; meeting ourselves would orphan the subtree in a cycle.
    let cursor = data['folderParentId'] as string | null;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === id || seen.has(cursor))
        throw new HttpError(400, 'A folder cannot be moved inside itself');
      seen.add(cursor);
      const folder = findDoc(db, workspaceId, 'folders', cursor);
      if (!folder) throw new HttpError(400, 'Parent folder not found');
      cursor = folder['folderParentId'] as string | null;
    }
  }
}

/** Deleting a folder never deletes content: its files and subfolders move up one level. */
function releaseFolder(db: Db, workspaceId: string, folder: Doc): void {
  const up = (folder['folderParentId'] as string | null) ?? null;
  db.run(
    'UPDATE media SET folderId = ? WHERE folderId = ? AND workspaceId = ?',
    up,
    folder.id,
    workspaceId,
  );
  for (const child of listDocs(db, workspaceId, 'folders')) {
    if (child['folderParentId'] !== folder.id) continue;
    const row = db.get<DocRow>(`SELECT ${COLUMNS} FROM docs WHERE id = ?`, child.id)!;
    const data = { ...(JSON.parse(row.data) as object), folderParentId: up };
    db.run('UPDATE docs SET data = ? WHERE id = ?', JSON.stringify(data), child.id);
  }
}

export function docRoutes(db: Db): Router {
  const router = Router();
  const locate = (req: Request) => {
    const collection = param(req, 'collection');
    const rule = ruleFor(collection);
    const workspaceId = workspaceOf(req);
    const doc = findDoc(db, workspaceId, collection, param(req, 'id'));
    if (!doc) throw notFound();
    return { collection, rule, workspaceId, doc };
  };

  router.get('/:collection', (req, res) => {
    const collection = param(req, 'collection');
    ruleFor(collection);
    const parentId = typeof req.query['parentId'] === 'string' ? req.query['parentId'] : undefined;
    res.json(listDocs(db, workspaceOf(req), collection, parentId));
  });

  router.post('/:collection', (req, res) => {
    const collection = param(req, 'collection');
    const rule = ruleFor(collection);
    const workspaceId = workspaceOf(req);
    const data = parse(rule.schema, req.body);
    const id = randomUUID();
    db.tx(() => {
      const parentId = assertParent(
        db,
        workspaceId,
        rule,
        (req.body as { parentId?: unknown })?.parentId,
      );
      checkInvariants(db, workspaceId, collection, data, null, parentId);
      const now = Date.now();
      db.run(
        `INSERT INTO docs (id, workspaceId, collection, parentId, position, data, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        workspaceId,
        collection,
        parentId,
        nextPosition(db, workspaceId, collection),
        JSON.stringify(data),
        now,
        now,
      );
    });
    res.status(201).json(findDoc(db, workspaceId, collection, id));
  });

  router.post('/:collection/reorder', (req, res) => {
    const collection = param(req, 'collection');
    ruleFor(collection);
    const workspaceId = workspaceOf(req);
    const { ids } = parse(z.object({ ids: z.array(z.string()).max(5000) }), req.body);
    db.tx(() => {
      ids.forEach((id, index) => {
        db.run(
          'UPDATE docs SET position = ? WHERE id = ? AND workspaceId = ? AND collection = ?',
          index,
          id,
          workspaceId,
          collection,
        );
      });
    });
    res.status(204).end();
  });

  router.get('/:collection/:id', (req, res) => {
    res.json(locate(req).doc);
  });

  router.put('/:collection/:id', (req, res) => {
    const { collection, rule, workspaceId, doc } = locate(req);
    const patch = parse(z.record(z.string(), z.unknown()), req.body);
    // Validate the merged result so a partial patch never resets untouched fields to defaults.
    const data = parse(rule.schema, { ...doc, ...patch });
    db.tx(() => {
      const parentId =
        'parentId' in patch ? assertParent(db, workspaceId, rule, patch['parentId']) : doc.parentId;
      checkInvariants(db, workspaceId, collection, data, doc.id, parentId);
      db.run(
        'UPDATE docs SET data = ?, parentId = ?, updatedAt = ? WHERE id = ?',
        JSON.stringify(data),
        parentId,
        Date.now(),
        doc.id,
      );
      if (parentId !== doc.parentId) {
        db.run(
          'UPDATE docs SET position = ? WHERE id = ?',
          nextPosition(db, workspaceId, collection),
          doc.id,
        );
      }
    });
    res.json(findDoc(db, workspaceId, collection, doc.id));
  });

  router.delete('/:collection/:id', (req, res) => {
    const { collection, workspaceId, doc } = locate(req);
    db.tx(() => {
      if (collection === 'folders') releaseFolder(db, workspaceId, doc);
      db.run('DELETE FROM docs WHERE id = ?', doc.id);
    });
    res.status(204).end();
  });

  return router;
}
