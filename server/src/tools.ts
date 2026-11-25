import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { listDocs, type Doc } from './docs.ts';
import { authOf, param, parse, workspaceOf } from './http.ts';
import { listMedia } from './media.ts';
import { proxy } from './proxy.ts';

/** Serves user-defined mock endpoints. Public on purpose: no session is read or required. */
export function mockHandler(db: Db): RequestHandler {
  return async (req, res) => {
    const segments = req.params['splat'] as unknown as string[] | undefined;
    const path = (segments ?? []).join('/').replace(/\/+$/, '');
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.status(204).end();
      return;
    }
    const endpoint = listDocs(db, param(req, 'workspaceId'), 'customEndpoints').find(
      (e) => e['enabled'] === true && e['method'] === method && e['path'] === path,
    );
    if (!endpoint) {
      res.status(404).json({ error: 'No enabled endpoint matches this method and path' });
      return;
    }
    const delay = Number(endpoint['delayMs']) || 0;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    // The body is user-authored: sandbox it so an HTML mock cannot script against this app's origin.
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.status(Number(endpoint['statusCode']));
    res.setHeader('Content-Type', `${String(endpoint['contentType'])}; charset=utf-8`);
    res.end(String(endpoint['body']));
  };
}

const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
const sum = (docs: Doc[], count: (doc: Doc) => number) =>
  docs.reduce((total, doc) => total + count(doc), 0);

export function reportSummary(db: Db, workspaceId: string, userId: string) {
  const docs = (name: string) => listDocs(db, workspaceId, name);
  const media = listMedia(db, workspaceId);
  const folders = docs('folders');
  const folderName = new Map(folders.map((f) => [f.id, String(f['name'])]));

  const group = (key: (m: (typeof media)[number]) => string) => {
    const result = new Map<string, { label: string; count: number; bytes: number }>();
    for (const item of media) {
      const label = key(item);
      const entry = result.get(label) ?? { label, count: 0, bytes: 0 };
      entry.count++;
      entry.bytes += item.size;
      result.set(label, entry);
    }
    return [...result.values()].sort((a, b) => b.bytes - a.bytes);
  };

  const chats = db.all<{
    id: string;
    name: string;
    type: string;
    messages: number;
    members: number;
    attachments: number;
  }>(
    `SELECT c.id, c.type,
       CASE WHEN c.type = 'group' THEN c.name ELSE COALESCE((SELECT u.name FROM members o JOIN users u ON u.id = o.userId
         WHERE o.conversationId = c.id AND o.userId != ?), 'Direct chat') END AS name,
       (SELECT COUNT(*) FROM messages x WHERE x.conversationId = c.id AND x.deletedAt IS NULL) AS messages,
       (SELECT COUNT(*) FROM members x WHERE x.conversationId = c.id) AS members,
       (SELECT COUNT(*) FROM chat_files x WHERE x.conversationId = c.id AND x.messageId IS NOT NULL) AS attachments
     FROM conversations c JOIN members m ON m.conversationId = c.id WHERE m.userId = ? ORDER BY messages DESC`,
    userId,
    userId,
  );

  const notes = docs('notes');
  const bills = docs('bills');
  const tasks = docs('tasks');
  const textChats = docs('textChats');
  const textMessages = textChats.flatMap((c) => list(c['messages']));

  return {
    generatedAt: Date.now(),
    storage: {
      totalCount: media.length,
      totalBytes: media.reduce((total, m) => total + m.size, 0),
      byType: group((m) => m.kind),
      byFolder: group((m) =>
        m.folderId ? (folderName.get(m.folderId) ?? 'Unsorted') : 'Unsorted',
      ),
      largest: [...media]
        .sort((a, b) => b.size - a.size)
        .slice(0, 10)
        .map((m) => ({ id: m.id, title: m.title, kind: m.kind, size: m.size })),
    },
    chats: chats.map((row) => ({ ...row })),
    modules: [
      { label: 'Folders', stats: { folders: folders.length } },
      {
        label: 'Notes',
        stats: {
          notes: notes.length,
          pinned: notes.filter((n) => n['pinned']).length,
          blocks: sum(notes, (n) => list(n['blocks']).length),
        },
      },
      {
        label: 'Bills',
        stats: {
          bills: bills.filter((b) => b['docType'] === 'bill').length,
          quotations: bills.filter((b) => b['docType'] === 'quotation').length,
          items: sum(bills, (b) => list(b['items']).length),
        },
      },
      { label: 'Books', stats: { books: docs('books').length, pages: docs('bookPages').length } },
      {
        label: 'Tasks',
        stats: {
          sections: docs('taskSections').length,
          tasks: tasks.length,
          completed: tasks.filter((t) => t['completed']).length,
        },
      },
      {
        label: 'Text chats',
        stats: {
          conversations: textChats.length,
          messages: textMessages.length,
          highlighted: textMessages.filter((m) => m['highlighted']).length,
        },
      },
      {
        label: 'Movies and slideshows',
        stats: {
          movies: docs('movies').length,
          slideshows: docs('slideshows').length,
          scenes: sum([...docs('movies'), ...docs('slideshows')], (m) => list(m['clips']).length),
        },
      },
      {
        label: 'Websites',
        stats: { sites: docs('sites').length, pages: docs('sitePages').length },
      },
      {
        label: 'Saved edits',
        stats: {
          pdf: docs('pdfProjects').length,
          pdfHighlights: sum(
            docs('pdfProjects'),
            (p) =>
              list((p['doc'] as Record<string, unknown> | undefined)?.['annotations']).filter(
                (a) => a['type'] === 'highlight',
              ).length,
          ),
          image: docs('imageProjects').length,
          video: docs('videoProjects').length,
        },
      },
      {
        label: 'APIs',
        stats: {
          customEndpoints: docs('customEndpoints').length,
          requests: docs('apiRequests').length,
        },
      },
    ],
  };
}

export function toolRoutes(db: Db, config: Config): Router {
  const router = Router();

  router.get('/reports/summary', (req, res) => {
    res.json(reportSummary(db, workspaceOf(req), authOf(req).user.id));
  });

  router.post('/api-tester/send', async (req, res) => {
    workspaceOf(req);
    const body = parse(
      z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
        url: z.string().trim().min(1, 'Enter a URL').max(4000),
        headers: z.record(z.string(), z.string()).default({}),
        body: z.string().max(1_000_000).nullable().default(null),
      }),
      req.body,
    );
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.headers)) {
      // These are owned by the HTTP client; letting them through would corrupt framing.
      if (
        !['host', 'content-length', 'connection', 'transfer-encoding'].includes(key.toLowerCase())
      ) {
        headers[key] = value;
      }
    }
    const sendsBody = body.body !== null && !['GET', 'HEAD'].includes(body.method);
    if (sendsBody) headers['Content-Length'] = String(Buffer.byteLength(body.body!));
    res.json(
      await proxy(
        { ...body, headers, body: sendsBody ? body.body : null },
        config.allowPrivateTargets,
      ),
    );
  });

  return router;
}
