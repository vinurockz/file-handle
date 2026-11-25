import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Db } from './db.ts';
import { findDoc } from './docs.ts';
import type { FileKind, FileStore } from './files.ts';
import { HttpError, notFound, param, parse, workspaceOf } from './http.ts';

export interface MediaRecord {
  id: string;
  folderId: string | null;
  kind: FileKind;
  title: string;
  mime: string;
  size: number;
  filename: string;
  createdAt: number;
  updatedAt: number;
}

const COLUMNS = 'id, folderId, kind, title, mime, size, filename, createdAt, updatedAt';
const publicMedia = ({ filename: _filename, ...rest }: MediaRecord) => rest;

export function findMedia(db: Db, workspaceId: string, id: string): MediaRecord | undefined {
  const row = db.get<MediaRecord>(
    `SELECT ${COLUMNS} FROM media WHERE id = ? AND workspaceId = ?`,
    id,
    workspaceId,
  );
  return row && { ...row };
}

export function listMedia(db: Db, workspaceId: string): MediaRecord[] {
  return db.all<MediaRecord>(
    `SELECT ${COLUMNS} FROM media WHERE workspaceId = ? ORDER BY createdAt DESC`,
    workspaceId,
  );
}

function checkFolder(db: Db, workspaceId: string, folderId: string | null): string | null {
  if (folderId && !findDoc(db, workspaceId, 'folders', folderId))
    throw new HttpError(400, 'Folder not found');
  return folderId;
}

/** Records a file that already sits in the FileStore. */
export function insertMedia(
  db: Db,
  workspaceId: string,
  file: { kind: FileKind; mime: string; filename: string; size: number },
  title: string,
  folderId: string | null,
): ReturnType<typeof publicMedia> {
  const id = randomUUID();
  const now = Date.now();
  db.run(
    `INSERT INTO media (id, workspaceId, folderId, kind, title, mime, size, filename, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    workspaceId,
    folderId,
    file.kind,
    title.slice(0, 200) || 'Untitled',
    file.mime,
    file.size,
    file.filename,
    now,
    now,
  );
  return publicMedia(findMedia(db, workspaceId, id)!);
}

export async function fileSize(fullPath: string): Promise<number> {
  return (await stat(fullPath)).size;
}

export function mediaRoutes(db: Db, files: FileStore): Router {
  const router = Router();
  const locate = (req: Request) => {
    const workspaceId = workspaceOf(req);
    const record = findMedia(db, workspaceId, param(req, 'id'));
    if (!record) throw notFound('File');
    return { workspaceId, record };
  };

  router.get('/', (req, res) => {
    res.json(listMedia(db, workspaceOf(req)).map(publicMedia));
  });

  router.post('/', files.upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'No file was uploaded');
    let adopted: string | null = null;
    try {
      const workspaceId = workspaceOf(req);
      const body = parse(
        z.object({
          title: z.string().max(300).optional(),
          folderId: z.string().max(64).optional(),
        }),
        req.body,
      );
      const folderId = checkFolder(db, workspaceId, body.folderId || null);
      const stored = await files.adopt(file, false);
      adopted = stored.filename;
      const fallback = file.originalname.replace(/\.[^.]+$/, '');
      res
        .status(201)
        .json(insertMedia(db, workspaceId, stored, body.title?.trim() || fallback, folderId));
    } catch (error) {
      await files.discard(file.path);
      if (adopted) await files.remove([adopted]);
      throw error;
    }
  });

  router.get('/:id/file', (req, res) => {
    const { record } = locate(req);
    const ext = record.filename.split('.').pop() ?? 'bin';
    files.send(
      res,
      record.filename,
      record.mime,
      `${record.title}.${ext}`,
      req.query['download'] === '1',
    );
  });

  router.put('/:id', (req, res) => {
    const { workspaceId, record } = locate(req);
    const patch = parse(
      z.object({
        title: z.string().trim().min(1, 'Enter a name').max(200).optional(),
        folderId: z.string().max(64).nullable().optional(),
      }),
      req.body,
    );
    const folderId =
      patch.folderId === undefined ? record.folderId : checkFolder(db, workspaceId, patch.folderId);
    db.run(
      'UPDATE media SET title = ?, folderId = ?, updatedAt = ? WHERE id = ?',
      patch.title ?? record.title,
      folderId,
      Date.now(),
      record.id,
    );
    res.json(publicMedia(findMedia(db, workspaceId, record.id)!));
  });

  router.delete('/:id', async (req, res) => {
    const { record } = locate(req);
    db.run('DELETE FROM media WHERE id = ?', record.id);
    await files.remove([record.filename]);
    res.status(204).end();
  });

  return router;
}
