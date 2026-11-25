import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Db } from './db.ts';
import type { FileKind, FileStore } from './files.ts';
import { authOf, HttpError, notFound, param, parse, type AuthUser } from './http.ts';
import { memberIds, type ChatHub } from './chat-hub.ts';

interface ConversationRow {
  id: string;
  type: 'direct' | 'group';
  name: string;
  description: string;
  imageFilename: string | null;
  createdAt: number;
  updatedAt: number;
}

interface MessageRow {
  seq: number;
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  replyToId: string | null;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
}

interface FileRow {
  id: string;
  conversationId: string;
  uploaderId: string;
  messageId: string | null;
  name: string;
  mime: string;
  kind: FileKind;
  size: number;
  filename: string;
}

type Role = 'admin' | 'member';
const MAX_ATTACHMENTS = 10;
const messageText = z.string().max(5000);
const userIds = z.array(z.string().max(64)).min(1).max(100);

export function messageView(db: Db, row: MessageRow) {
  const deleted = row.deletedAt !== null;
  const reply = row.replyToId
    ? db.get<{ id: string; senderId: string; text: string; deletedAt: number | null }>(
        'SELECT id, senderId, text, deletedAt FROM messages WHERE id = ?',
        row.replyToId,
      )
    : undefined;
  return {
    seq: row.seq,
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    text: deleted ? '' : row.text,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    replyTo: reply
      ? {
          id: reply.id,
          senderId: reply.senderId,
          text: reply.deletedAt === null ? reply.text.slice(0, 200) : '',
          deleted: reply.deletedAt !== null,
        }
      : null,
    attachments: deleted
      ? []
      : db.all(
          'SELECT id, name, mime, kind, size FROM chat_files WHERE messageId = ? ORDER BY rowid',
          row.id,
        ),
    reactions: deleted
      ? []
      : db.all('SELECT userId, emoji FROM reactions WHERE messageId = ? ORDER BY rowid', row.id),
  };
}

function conversationView(db: Db, hub: ChatHub, row: ConversationRow, viewerId: string) {
  const members = db.all<AuthUser & { role: Role; lastReadSeq: number }>(
    `SELECT u.id, u.username, u.name, u.color, m.role, m.lastReadSeq FROM members m
     JOIN users u ON u.id = m.userId WHERE m.conversationId = ? ORDER BY m.joinedAt, u.name`,
    row.id,
  );
  const last = db.get<MessageRow>(
    'SELECT * FROM messages WHERE conversationId = ? ORDER BY seq DESC LIMIT 1',
    row.id,
  );
  const mine = members.find((m) => m.id === viewerId);
  const unread = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages
     WHERE conversationId = ? AND seq > ? AND senderId != ? AND deletedAt IS NULL`,
    row.id,
    mine?.lastReadSeq ?? 0,
    viewerId,
  )!.n;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    // The stored name changes with each new picture, which makes a good cache-busting version.
    imageVersion: row.imageFilename ? row.imageFilename.slice(0, 8) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    members: members.map((m) => ({ ...m, online: hub.isOnline(m.id) })),
    lastMessage: last ? messageView(db, last) : null,
    unread,
  };
}

export function chatRoutes(db: Db, files: FileStore, hub: ChatHub): Router {
  const router = Router();

  const membership = (req: Request) => {
    const { user } = authOf(req);
    const row = db.get<ConversationRow & { role: Role }>(
      `SELECT c.*, m.role FROM conversations c
       JOIN members m ON m.conversationId = c.id WHERE c.id = ? AND m.userId = ?`,
      param(req, 'id'),
      user.id,
    );
    // Non-members get 404 so conversation ids cannot be probed.
    if (!row) throw notFound('Conversation');
    return { user, conversation: row };
  };

  const requireGroupAdmin = (conversation: ConversationRow & { role: Role }) => {
    if (conversation.type !== 'group') throw new HttpError(400, 'Only group chats can be changed');
    if (conversation.role !== 'admin') throw new HttpError(403, 'Only a group admin can do that');
  };

  const conversationById = (id: string) =>
    db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id);

  /** Each member gets their own view because unread counts differ. */
  const broadcastConversation = (id: string) => {
    const row = conversationById(id);
    if (!row) return;
    for (const userId of memberIds(db, id)) {
      hub.send([userId], {
        type: 'conversation',
        conversation: conversationView(db, hub, row, userId),
      });
    }
  };

  const addMember = (conversationId: string, userId: string, role: Role) => {
    if (!db.get('SELECT 1 FROM users WHERE id = ?', userId))
      throw new HttpError(400, 'Unknown user');
    // New members start with existing history marked read.
    const seq = db.get<{ s: number }>(
      'SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE conversationId = ?',
      conversationId,
    )!.s;
    db.run(
      `INSERT OR IGNORE INTO members (conversationId, userId, role, lastReadSeq, joinedAt)
       VALUES (?, ?, ?, ?, ?)`,
      conversationId,
      userId,
      role,
      seq,
      Date.now(),
    );
  };

  const ownMessage = (req: Request) => {
    const { user, conversation } = membership(req);
    const message = db.get<MessageRow>(
      'SELECT * FROM messages WHERE id = ? AND conversationId = ?',
      param(req, 'messageId'),
      conversation.id,
    );
    if (!message || message.deletedAt !== null) throw notFound('Message');
    return { user, conversation, message };
  };

  const publishMessage = (id: string, type: 'message' | 'message-updated') => {
    const row = db.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id)!;
    const view = messageView(db, row);
    hub.send(memberIds(db, row.conversationId), { type, message: view });
    return view;
  };

  router.get('/users', (req, res) => {
    const { user } = authOf(req);
    const q = String(req.query['q'] ?? '')
      .trim()
      .slice(0, 60);
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    res.json(
      db.all(
        `SELECT id, username, name, color FROM users
         WHERE id != ? AND (name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\') ORDER BY name LIMIT 30`,
        user.id,
        like,
        like,
      ),
    );
  });

  router.get('/conversations', (req, res) => {
    const { user } = authOf(req);
    const rows = db.all<ConversationRow>(
      `SELECT c.* FROM conversations c JOIN members m ON m.conversationId = c.id
       WHERE m.userId = ? ORDER BY c.updatedAt DESC`,
      user.id,
    );
    res.json(rows.map((row) => conversationView(db, hub, row, user.id)));
  });

  router.post('/conversations', (req, res) => {
    const { user } = authOf(req);
    const body = parse(
      z.object({
        type: z.enum(['direct', 'group']),
        memberIds: userIds,
        name: z.string().trim().max(80).default(''),
      }),
      req.body,
    );
    const others = [...new Set(body.memberIds)].filter((id) => id !== user.id);
    if (others.length === 0) throw new HttpError(400, 'Choose at least one other person');
    if (body.type === 'direct' && others.length !== 1)
      throw new HttpError(400, 'A direct chat has one other person');
    if (body.type === 'group' && !body.name) throw new HttpError(400, 'Name the group');

    const directKey = body.type === 'direct' ? [user.id, others[0]!].sort().join(':') : null;
    const existing = directKey
      ? db.get<ConversationRow>('SELECT * FROM conversations WHERE directKey = ?', directKey)
      : undefined;
    const id = existing?.id ?? randomUUID();
    db.tx(() => {
      const now = Date.now();
      if (!existing) {
        db.run(
          'INSERT INTO conversations (id, type, name, directKey, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
          id,
          body.type,
          body.type === 'group' ? body.name : '',
          directKey,
          now,
          now,
        );
      }
      addMember(id, user.id, 'admin');
      for (const other of others) addMember(id, other, body.type === 'direct' ? 'admin' : 'member');
    });
    broadcastConversation(id);
    res
      .status(existing ? 200 : 201)
      .json(conversationView(db, hub, conversationById(id)!, user.id));
  });

  router.put('/conversations/:id', (req, res) => {
    const { user, conversation } = membership(req);
    requireGroupAdmin(conversation);
    const patch = parse(
      z.object({
        name: z.string().trim().min(1, 'Name the group').max(80).optional(),
        description: z.string().trim().max(500).optional(),
      }),
      req.body,
    );
    db.run(
      'UPDATE conversations SET name = ?, description = ?, updatedAt = ? WHERE id = ?',
      patch.name ?? conversation.name,
      patch.description ?? conversation.description,
      Date.now(),
      conversation.id,
    );
    broadcastConversation(conversation.id);
    res.json(conversationView(db, hub, conversationById(conversation.id)!, user.id));
  });

  const imageOf = (id: string) =>
    db.get<{ imageFilename: string | null; imageMime: string | null }>(
      'SELECT imageFilename, imageMime FROM conversations WHERE id = ?',
      id,
    )!;

  const replaceImage = async (id: string, filename: string | null, mime: string | null) => {
    const previous = imageOf(id).imageFilename;
    db.run(
      'UPDATE conversations SET imageFilename = ?, imageMime = ? WHERE id = ?',
      filename,
      mime,
      id,
    );
    if (previous) await files.remove([previous]);
    broadcastConversation(id);
  };

  router.post('/conversations/:id/image', files.upload.single('file'), async (req, res) => {
    const upload = req.file;
    if (!upload) throw new HttpError(400, 'No picture was uploaded');
    try {
      const { user, conversation } = membership(req);
      requireGroupAdmin(conversation);
      const stored = await files.adoptImage(upload);
      await replaceImage(conversation.id, stored.filename, stored.mime);
      res.json(conversationView(db, hub, conversationById(conversation.id)!, user.id));
    } finally {
      await files.discard(upload.path);
    }
  });

  router.delete('/conversations/:id/image', async (req, res) => {
    const { user, conversation } = membership(req);
    requireGroupAdmin(conversation);
    await replaceImage(conversation.id, null, null);
    res.json(conversationView(db, hub, conversationById(conversation.id)!, user.id));
  });

  router.get('/conversations/:id/image', (req, res) => {
    const { conversation } = membership(req);
    const { imageFilename, imageMime } = imageOf(conversation.id);
    if (!imageFilename) throw notFound('Picture');
    files.send(res, imageFilename, imageMime!, 'group-picture');
  });

  router.post('/conversations/:id/members', (req, res) => {
    const { user, conversation } = membership(req);
    requireGroupAdmin(conversation);
    const body = parse(z.object({ userIds }), req.body);
    db.tx(() => body.userIds.forEach((id) => addMember(conversation.id, id, 'member')));
    broadcastConversation(conversation.id);
    res.json(conversationView(db, hub, conversationById(conversation.id)!, user.id));
  });

  router.delete('/conversations/:id/members/:userId', async (req, res) => {
    const { user, conversation } = membership(req);
    const target = param(req, 'userId');
    if (conversation.type !== 'group') throw new HttpError(400, 'Only group chats can be left');
    if (target !== user.id) requireGroupAdmin(conversation);
    if (!memberIds(db, conversation.id).includes(target)) throw notFound('Member');

    let orphaned: string[] = [];
    let removedConversation = false;
    db.tx(() => {
      db.run(
        'DELETE FROM members WHERE conversationId = ? AND userId = ?',
        conversation.id,
        target,
      );
      const remaining = db.all<{ userId: string; role: Role }>(
        'SELECT userId, role FROM members WHERE conversationId = ? ORDER BY joinedAt, rowid',
        conversation.id,
      );
      if (remaining.length === 0) {
        orphaned = db
          .all<{ filename: string }>(
            'SELECT filename FROM chat_files WHERE conversationId = ?',
            conversation.id,
          )
          .map((row) => row.filename);
        if (conversation.imageFilename) orphaned.push(conversation.imageFilename);
        db.run('DELETE FROM conversations WHERE id = ?', conversation.id);
        removedConversation = true;
      } else if (!remaining.some((m) => m.role === 'admin')) {
        db.run(
          "UPDATE members SET role = 'admin' WHERE conversationId = ? AND userId = ?",
          conversation.id,
          remaining[0]!.userId,
        );
      }
    });
    await files.remove(orphaned);
    hub.send([target], { type: 'conversation-removed', conversationId: conversation.id });
    if (!removedConversation) broadcastConversation(conversation.id);
    res.status(204).end();
  });

  router.get('/conversations/:id/messages', (req, res) => {
    const { conversation } = membership(req);
    const query = parse(
      z.object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        q: z.string().max(100).optional(),
      }),
      req.query,
    );
    const like = query.q ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const rows = db.all<MessageRow>(
      `SELECT * FROM messages WHERE conversationId = ? AND seq < ?
       ${like ? "AND deletedAt IS NULL AND text LIKE ? ESCAPE '\\'" : ''}
       ORDER BY seq DESC LIMIT ?`,
      ...[
        conversation.id,
        query.before ?? Number.MAX_SAFE_INTEGER,
        ...(like ? [like] : []),
        query.limit + 1,
      ],
    );
    const hasMore = rows.length > query.limit;
    res.json({
      hasMore,
      messages: rows
        .slice(0, query.limit)
        .reverse()
        .map((row) => messageView(db, row)),
    });
  });

  router.post('/conversations/:id/messages', (req, res) => {
    const { user, conversation } = membership(req);
    const body = parse(
      z.object({
        text: messageText.default(''),
        replyToId: z.string().max(64).nullable().default(null),
        fileIds: z.array(z.string().max(64)).max(MAX_ATTACHMENTS).default([]),
      }),
      req.body,
    );
    if (!body.text.trim() && body.fileIds.length === 0)
      throw new HttpError(400, 'Write a message or attach a file');
    const id = randomUUID();
    db.tx(() => {
      if (
        body.replyToId &&
        !db.get(
          'SELECT 1 FROM messages WHERE id = ? AND conversationId = ?',
          body.replyToId,
          conversation.id,
        )
      ) {
        throw new HttpError(400, 'The message you replied to is not in this chat');
      }
      const now = Date.now();
      const result = db.run(
        `INSERT INTO messages (id, conversationId, senderId, text, replyToId, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        conversation.id,
        user.id,
        body.text,
        body.replyToId,
        now,
      );
      for (const fileId of new Set(body.fileIds)) {
        // Only your own, not-yet-sent uploads in this conversation can be attached.
        const linked = db.run(
          `UPDATE chat_files SET messageId = ?
           WHERE id = ? AND conversationId = ? AND uploaderId = ? AND messageId IS NULL`,
          id,
          fileId,
          conversation.id,
          user.id,
        );
        if (linked.changes !== 1) throw new HttpError(400, 'An attachment is no longer available');
      }
      db.run('UPDATE conversations SET updatedAt = ? WHERE id = ?', now, conversation.id);
      db.run(
        'UPDATE members SET lastReadSeq = ? WHERE conversationId = ? AND userId = ?',
        result.lastInsertRowid,
        conversation.id,
        user.id,
      );
    });
    res.status(201).json(publishMessage(id, 'message'));
  });

  router.put('/conversations/:id/messages/:messageId', (req, res) => {
    const { user, message } = ownMessage(req);
    if (message.senderId !== user.id)
      throw new HttpError(403, 'You can only edit your own messages');
    const { text } = parse(z.object({ text: messageText }), req.body);
    const hasFiles = db.get('SELECT 1 FROM chat_files WHERE messageId = ?', message.id);
    if (!text.trim() && !hasFiles) throw new HttpError(400, 'A message cannot be empty');
    db.run('UPDATE messages SET text = ?, editedAt = ? WHERE id = ?', text, Date.now(), message.id);
    res.json(publishMessage(message.id, 'message-updated'));
  });

  router.delete('/conversations/:id/messages/:messageId', async (req, res) => {
    const { user, conversation, message } = ownMessage(req);
    const groupAdmin = conversation.type === 'group' && conversation.role === 'admin';
    if (message.senderId !== user.id && !groupAdmin) {
      throw new HttpError(403, 'You can only delete your own messages');
    }
    const stored = db.all<{ filename: string }>(
      'SELECT filename FROM chat_files WHERE messageId = ?',
      message.id,
    );
    db.tx(() => {
      db.run("UPDATE messages SET text = '', deletedAt = ? WHERE id = ?", Date.now(), message.id);
      db.run('DELETE FROM chat_files WHERE messageId = ?', message.id);
      db.run('DELETE FROM reactions WHERE messageId = ?', message.id);
    });
    await files.remove(stored.map((row) => row.filename));
    res.json(publishMessage(message.id, 'message-updated'));
  });

  router.post('/conversations/:id/messages/:messageId/reactions', (req, res) => {
    const { user, message } = ownMessage(req);
    const { emoji } = parse(z.object({ emoji: z.string().min(1).max(16) }), req.body);
    const removed = db.run(
      'DELETE FROM reactions WHERE messageId = ? AND userId = ? AND emoji = ?',
      message.id,
      user.id,
      emoji,
    );
    if (removed.changes === 0) {
      db.run(
        'INSERT INTO reactions (messageId, userId, emoji) VALUES (?, ?, ?)',
        message.id,
        user.id,
        emoji,
      );
    }
    res.json(publishMessage(message.id, 'message-updated'));
  });

  router.post('/conversations/:id/read', (req, res) => {
    const { user, conversation } = membership(req);
    const { seq } = parse(z.object({ seq: z.number().int().min(0) }), req.body);
    const changed = db.run(
      `UPDATE members SET lastReadSeq = MIN(?, (SELECT COALESCE(MAX(seq), 0) FROM messages WHERE conversationId = ?))
       WHERE conversationId = ? AND userId = ? AND lastReadSeq < ?`,
      seq,
      conversation.id,
      conversation.id,
      user.id,
      seq,
    );
    if (changed.changes) {
      hub.send(memberIds(db, conversation.id), {
        type: 'read',
        conversationId: conversation.id,
        userId: user.id,
        seq,
      });
    }
    res.status(204).end();
  });

  router.post('/conversations/:id/files', files.upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'No file was uploaded');
    try {
      const { user, conversation } = membership(req);
      const stored = await files.adopt(file, true);
      const id = randomUUID();
      const name = file.originalname.slice(0, 200) || 'file';
      db.run(
        `INSERT INTO chat_files (id, conversationId, uploaderId, messageId, name, mime, kind, size, filename, createdAt)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        id,
        conversation.id,
        user.id,
        name,
        stored.mime,
        stored.kind,
        stored.size,
        stored.filename,
        Date.now(),
      );
      res.status(201).json({ id, name, mime: stored.mime, kind: stored.kind, size: stored.size });
    } finally {
      await files.discard(file.path);
    }
  });

  router.get('/files/:fileId', (req, res) => {
    const { user } = authOf(req);
    const row = db.get<FileRow>(
      `SELECT f.* FROM chat_files f JOIN members m ON m.conversationId = f.conversationId AND m.userId = ?
       WHERE f.id = ?`,
      user.id,
      param(req, 'fileId'),
    );
    if (!row || (row.messageId === null && row.uploaderId !== user.id)) throw notFound('File');
    files.send(res, row.filename, row.mime, row.name, req.query['download'] === '1');
  });

  return router;
}
