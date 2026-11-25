/** Optional Google sign-in (authorization-code flow). Inactive until both credentials are configured. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { HttpError } from './http.ts';

const STATE_COOKIE = 'studio_oauth_state';
const tokenReply = z.object({ access_token: z.string().min(1) });
const profileReply = z.object({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.literal(true),
  name: z.string().optional(),
});

const readCookie = (header: string | undefined, name: string): string => {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
};

const matches = (a: string, b: string) =>
  a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A username derived from the email address that no other account already has. */
function freeUsername(db: Db, email: string): string {
  const base =
    email
      .split('@')[0]!
      .replace(/[^a-zA-Z0-9_.-]/g, '')
      .slice(0, 24) || 'user';
  let candidate = base.padEnd(3, '_');
  for (let i = 2; db.get('SELECT 1 FROM users WHERE username = ?', candidate); i++) {
    candidate = `${base}${i}`;
  }
  return candidate;
}

export function googleRoutes(
  db: Db,
  config: Config,
  startSession: (res: Response, userId: string) => void,
  colorFor: (index: number) => string,
): Router {
  const router = Router();
  const configured = () => {
    if (!config.google) throw new HttpError(501, 'Google sign-in is not set up on this server');
    return config.google;
  };

  router.get('/auth/google/status', (_req, res) => {
    res.json({ configured: Boolean(config.google) });
  });

  router.get('/auth/google/start', (_req, res) => {
    const google = configured();
    const state = randomBytes(24).toString('hex');
    // Lax, because Google's redirect back to us is a cross-site navigation.
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      maxAge: 5 * 60_000,
      path: '/api/auth/google',
    });
    const query = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: google.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${query}`);
  });

  router.get('/auth/google/callback', async (req, res) => {
    const google = configured();
    const state = String(req.query['state'] ?? '');
    if (!matches(state, readCookie(req.headers.cookie, STATE_COOKIE))) {
      throw new HttpError(400, 'This sign-in attempt expired. Please try again.');
    }
    res.clearCookie(STATE_COOKIE, { path: '/api/auth/google' });
    let profile: z.output<typeof profileReply>;
    try {
      const tokens = await config.oauthFetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: google.clientId,
          client_secret: google.clientSecret,
          code: String(req.query['code'] ?? ''),
          redirect_uri: google.redirectUri,
          grant_type: 'authorization_code',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!tokens.ok) throw new Error(`token exchange returned ${tokens.status}`);
      const { access_token } = tokenReply.parse(await tokens.json());
      const info = await config.oauthFetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!info.ok) throw new Error(`profile request returned ${info.status}`);
      profile = profileReply.parse(await info.json());
    } catch (error) {
      console.error('Google sign-in failed:', (error as Error).message);
      throw new HttpError(502, 'Google sign-in failed. Please try again.');
    }
    // Accounts are matched on Google's stable id only, never by guessing from a username.
    let userId = db.get<{ id: string }>(
      'SELECT id FROM users WHERE googleSub = ?',
      profile.sub,
    )?.id;
    if (!userId) {
      userId = randomUUID();
      const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
      db.run(
        `INSERT INTO users (id, username, name, color, passwordHash, createdAt, googleSub, email)
         VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
        userId,
        freeUsername(db, profile.email),
        (profile.name ?? profile.email.split('@')[0]!).slice(0, 60),
        colorFor(count),
        Date.now(),
        profile.sub,
        profile.email,
      );
    }
    startSession(res, userId);
    res.redirect('/');
  });

  return router;
}
