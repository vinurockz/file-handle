import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { FileStore } from './files.ts';
import { googleRoutes } from './google.ts';
import {
  authOf,
  HttpError,
  notFound,
  param,
  parse,
  type AuthContext,
  type AuthUser,
} from './http.ts';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  length: number,
) => Promise<Buffer>;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = 'studio_session';
const COLORS = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
  '#14b8a6',
];

export const pickColor = (seed: number) => COLORS[Math.abs(seed) % COLORS.length]!;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt = '', expected = ''] = stored.split(':');
  const key = await scryptAsync(password, Buffer.from(salt, 'hex'), 64);
  const wanted = Buffer.from(expected, 'hex');
  return wanted.length === key.length && timingSafeEqual(wanted, key);
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function readSessionToken(cookieHeader: string | undefined): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=') || null;
  }
  return null;
}

export function lookupSession(db: Db, cookieHeader: string | undefined): AuthContext | null {
  const token = readSessionToken(cookieHeader);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = db.get<AuthUser & { workspaceId: string | null }>(
    `SELECT u.id, u.username, u.name, u.color, s.workspaceId FROM sessions s
     JOIN users u ON u.id = s.userId WHERE s.tokenHash = ? AND s.expiresAt > ?`,
    tokenHash,
    Date.now(),
  );
  if (!row) return null;
  const { workspaceId, ...user } = row;
  return { user: { ...user }, workspaceId, tokenHash };
}

export function requireAuth(db: Db) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const context = lookupSession(db, req.headers.cookie);
    if (!context) {
      next(new HttpError(401, 'Please sign in'));
      return;
    }
    req.auth = context;
    next();
  };
}

/** Slows password guessing: after 8 failures for one address+username, wait out the window. */
class LoginThrottle {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  check(key: string): void {
    const entry = this.failures.get(key);
    if (entry && entry.resetAt > Date.now() && entry.count >= 8) {
      throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    }
  }

  fail(key: string): void {
    const now = Date.now();
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now)
      this.failures.set(key, { count: 1, resetAt: now + 5 * 60_000 });
    else entry.count++;
  }

  clear(key: string): void {
    this.failures.delete(key);
  }
}

const credentials = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.-]{3,32}$/, 'Use 3-32 letters, numbers, dots, dashes or underscores'),
  password: z.string().min(8, 'Password needs at least 8 characters').max(200),
});
const registration = credentials.extend({
  name: z.string().trim().min(1, 'Enter your name').max(60),
});
const workspaceBody = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(80),
  description: z.string().trim().max(500).default(''),
});

export function authRoutes(
  db: Db,
  config: Config,
  files: FileStore,
  onSessionEnd: (tokenHash: string) => void,
): Router {
  const router = Router();
  const throttle = new LoginThrottle();
  const guard = requireAuth(db);

  const startSession = (res: Response, userId: string) => {
    const token = randomBytes(32).toString('hex');
    db.run('DELETE FROM sessions WHERE expiresAt <= ?', Date.now());
    db.run(
      'INSERT INTO sessions (tokenHash, userId, workspaceId, expiresAt) VALUES (?, ?, NULL, ?)',
      hashToken(token),
      userId,
      Date.now() + SESSION_MS,
    );
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.secureCookies,
      maxAge: SESSION_MS,
      path: '/',
    });
  };
  const publicUser = (id: string) =>
    db.get<AuthUser>('SELECT id, username, name, color FROM users WHERE id = ?', id)!;

  router.use(googleRoutes(db, config, startSession, pickColor));

  router.post('/auth/register', async (req, res) => {
    const body = parse(registration, req.body);
    const passwordHash = await hashPassword(body.password);
    if (db.get('SELECT 1 FROM users WHERE username = ?', body.username)) {
      throw new HttpError(409, 'That username is taken');
    }
    const id = randomUUID();
    const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
    db.run(
      'INSERT INTO users (id, username, name, color, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      body.username,
      body.name,
      pickColor(count),
      passwordHash,
      Date.now(),
    );
    startSession(res, id);
    res.status(201).json({ user: publicUser(id), workspaceId: null });
  });

  router.post('/auth/login', async (req, res) => {
    const body = parse(
      z.object({ username: z.string().trim().max(64), password: z.string().max(200) }),
      req.body,
    );
    const key = `${req.ip}:${body.username.toLowerCase()}`;
    throttle.check(key);
    const row = db.get<{ id: string; passwordHash: string }>(
      'SELECT id, passwordHash FROM users WHERE username = ?',
      body.username,
    );
    if (!row || !(await verifyPassword(body.password, row.passwordHash))) {
      throttle.fail(key);
      throw new HttpError(401, 'Wrong username or password');
    }
    throttle.clear(key);
    startSession(res, row.id);
    res.json({ user: publicUser(row.id), workspaceId: null });
  });

  router.get('/auth/me', (req, res) => {
    const context = lookupSession(db, req.headers.cookie);
    res.json(
      context
        ? { user: context.user, workspaceId: context.workspaceId }
        : { user: null, workspaceId: null },
    );
  });

  router.post('/auth/logout', guard, (req, res) => {
    const { tokenHash } = authOf(req);
    db.run('DELETE FROM sessions WHERE tokenHash = ?', tokenHash);
    onSessionEnd(tokenHash);
    res.clearCookie(COOKIE, { path: '/' });
    res.status(204).end();
  });

  const ownedWorkspace = (req: Request) => {
    const row = db.get<{ id: string }>(
      'SELECT id FROM workspaces WHERE id = ? AND ownerId = ?',
      param(req, 'id'),
      authOf(req).user.id,
    );
    if (!row) throw notFound('Workspace');
    return row.id;
  };
  const WORKSPACE = `id, name, description, color, createdAt, updatedAt, photo IS NOT NULL AS hasPhoto`;
  const publicWorkspace = (row: Record<string, unknown>) => ({
    ...row,
    hasPhoto: Boolean(row['hasPhoto']),
  });
  const workspaceById = (id: string) =>
    publicWorkspace(
      db.get<Record<string, unknown>>(`SELECT ${WORKSPACE} FROM workspaces WHERE id = ?`, id)!,
    );
  const photoOf = (id: string) =>
    db.get<{ photo: string | null; photoMime: string | null }>(
      'SELECT photo, photoMime FROM workspaces WHERE id = ?',
      id,
    )!;

  router.get('/workspaces', guard, (req, res) => {
    res.json(
      db
        .all<Record<string, unknown>>(
          `SELECT ${WORKSPACE} FROM workspaces WHERE ownerId = ? ORDER BY createdAt`,
          authOf(req).user.id,
        )
        .map(publicWorkspace),
    );
  });

  router.post('/workspaces', guard, (req, res) => {
    const body = parse(workspaceBody, req.body);
    const id = randomUUID();
    const now = Date.now();
    const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces')!.n;
    db.run(
      `INSERT INTO workspaces (id, ownerId, name, description, color, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      authOf(req).user.id,
      body.name,
      body.description,
      pickColor(count + 2),
      now,
      now,
    );
    res.status(201).json(workspaceById(id));
  });

  router.put('/workspaces/:id', guard, (req, res) => {
    const id = ownedWorkspace(req);
    const body = parse(workspaceBody, req.body);
    db.run(
      'UPDATE workspaces SET name = ?, description = ?, updatedAt = ? WHERE id = ?',
      body.name,
      body.description,
      Date.now(),
      id,
    );
    res.json(workspaceById(id));
  });

  router.delete('/workspaces/:id', guard, async (req, res) => {
    const id = ownedWorkspace(req);
    const stored = db.all<{ filename: string }>(
      'SELECT filename FROM media WHERE workspaceId = ?',
      id,
    );
    const { photo } = photoOf(id);
    db.run('DELETE FROM workspaces WHERE id = ?', id);
    await files.remove([...stored.map((row) => row.filename), ...(photo ? [photo] : [])]);
    res.status(204).end();
  });

  router.post('/workspaces/:id/photo', guard, files.upload.single('file'), async (req, res) => {
    const upload = req.file;
    if (!upload) throw new HttpError(400, 'No picture was uploaded');
    try {
      const id = ownedWorkspace(req);
      const stored = await files.adoptImage(upload);
      const previous = photoOf(id).photo;
      db.run(
        'UPDATE workspaces SET photo = ?, photoMime = ?, updatedAt = ? WHERE id = ?',
        stored.filename,
        stored.mime,
        Date.now(),
        id,
      );
      if (previous) await files.remove([previous]);
      res.json(workspaceById(id));
    } finally {
      await files.discard(upload.path);
    }
  });

  router.get('/workspaces/:id/photo', guard, (req, res) => {
    const { photo, photoMime } = photoOf(ownedWorkspace(req));
    if (!photo) throw notFound('Photo');
    files.send(res, photo, photoMime!, 'photo');
  });

  router.delete('/workspaces/:id/photo', guard, async (req, res) => {
    const id = ownedWorkspace(req);
    const { photo } = photoOf(id);
    db.run(
      'UPDATE workspaces SET photo = NULL, photoMime = NULL, updatedAt = ? WHERE id = ?',
      Date.now(),
      id,
    );
    if (photo) await files.remove([photo]);
    res.json(workspaceById(id));
  });

  router.post('/session/workspace', guard, (req, res) => {
    const { workspaceId } = parse(z.object({ workspaceId: z.string().nullable() }), req.body);
    const { user, tokenHash } = authOf(req);
    if (
      workspaceId &&
      !db.get('SELECT 1 FROM workspaces WHERE id = ? AND ownerId = ?', workspaceId, user.id)
    ) {
      throw notFound('Workspace');
    }
    db.run('UPDATE sessions SET workspaceId = ? WHERE tokenHash = ?', workspaceId, tokenHash);
    res.json({ user, workspaceId });
  });

  return router;
}
