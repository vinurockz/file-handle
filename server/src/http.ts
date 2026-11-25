import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const notFound = (what = 'Item') => new HttpError(404, `${what} not found`);

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.join('.') ?? '';
  throw new HttpError(400, `${where ? `${where}: ` : ''}${issue?.message ?? 'Invalid input'}`);
}

export interface AuthUser {
  id: string;
  username: string;
  name: string;
  color: string;
}

export interface AuthContext {
  user: AuthUser;
  workspaceId: string | null;
  tokenHash: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function authOf(req: Request): AuthContext {
  if (!req.auth) throw new HttpError(401, 'Please sign in');
  return req.auth;
}

export function workspaceOf(req: Request): string {
  const { workspaceId } = authOf(req);
  if (!workspaceId) throw new HttpError(409, 'Choose a workspace first');
  // Tabs share one session. Without this, a tab left on another workspace would write into the new one.
  const expected = req.get('X-Workspace');
  if (expected && expected !== workspaceId) {
    throw new HttpError(409, 'The workspace was changed in another tab. Reload this page.');
  }
  return workspaceId;
}

/** Express 5 types route params as `string | string[]`; ours are always single segments. */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') throw new HttpError(400, `Missing ${name}`);
  return value;
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const known = error as { status?: number; code?: string; type?: string; message?: string };
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
  } else if (known.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'That file is too large' });
  } else if (typeof known.status === 'number' && known.status < 500) {
    res.status(known.status).json({ error: known.message ?? 'Bad request' });
  } else {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong on the server' });
  }
}
