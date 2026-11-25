import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  clientDir: string;
  allowedOrigins: string[];
  /** Lets the API Tester call loopback/LAN addresses. Never enable on a shared server. */
  allowPrivateTargets: boolean;
  secureCookies: boolean;
  maxUploadBytes: number;
  /** Google sign-in credentials, or null to leave it switched off. */
  google: { clientId: string; clientSecret: string; redirectUri: string } | null;
  /** Used for the two calls to Google; replaceable in tests. */
  oauthFetch: typeof fetch;
}

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env['HOST'] ?? '127.0.0.1';
  const privateTargets = env['ALLOW_PRIVATE_TARGETS'];
  const clientId = env['GOOGLE_CLIENT_ID'];
  const clientSecret = env['GOOGLE_CLIENT_SECRET'];
  return {
    host,
    port: Number(env['PORT'] ?? 3000),
    google:
      clientId && clientSecret
        ? {
            clientId,
            clientSecret,
            redirectUri:
              env['GOOGLE_REDIRECT_URI'] ??
              `http://localhost:${Number(env['PORT'] ?? 3000)}/api/auth/google/callback`,
          }
        : null,
    oauthFetch: fetch,
    dataDir: path.resolve(env['DATA_DIR'] ?? path.join(serverRoot, 'data')),
    clientDir: path.resolve(serverRoot, '..', 'client', 'dist', 'studio', 'browser'),
    allowedOrigins: (env['ALLOWED_ORIGINS'] ?? 'http://localhost:4200,http://127.0.0.1:4200')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    allowPrivateTargets: privateTargets === undefined ? LOOPBACK.has(host) : privateTargets === '1',
    secureCookies: env['SECURE_COOKIES'] === '1',
    maxUploadBytes: Number(env['MAX_UPLOAD_MB'] ?? 500) * 1024 * 1024,
  };
}
