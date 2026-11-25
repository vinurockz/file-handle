import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import express, { type Express } from 'express';
import type { Config } from './config.ts';
import { Db } from './db.ts';
import { FileStore } from './files.ts';
import { errorHandler, HttpError } from './http.ts';
import { authRoutes, requireAuth } from './auth.ts';
import { docRoutes } from './docs.ts';
import { mediaRoutes } from './media.ts';
import { ChatHub } from './chat-hub.ts';
import { chatRoutes } from './chat.ts';
import { VideoQueue, videoRoutes } from './video.ts';
import { mockHandler, toolRoutes } from './tools.ts';

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "connect-src 'self' data: blob: ws: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: https:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' mailto:",
  "frame-ancestors 'self'",
].join('; ');

export interface StudioServer {
  app: Express;
  server: Server;
  close(): Promise<void>;
}

export function createApp(config: Config): StudioServer {
  const db = new Db(config.dataDir);
  const files = new FileStore(config);
  const hub = new ChatHub(db);
  const queue = new VideoQueue(db, files);
  const app = express();
  app.disable('x-powered-by');

  // Public mock endpoints come before the session and CSRF checks.
  app.all(
    '/api/mock/:workspaceId/*splat',
    express.raw({ type: () => true, limit: '1mb' }),
    mockHandler(db),
  );

  app.use('/api', (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    // A custom header cannot be sent cross-site without a CORS preflight, which we never grant.
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.get('X-Requested-With') !== 'studio'
    ) {
      next(new HttpError(403, 'Missing request header'));
      return;
    }
    next();
  });
  app.use('/api', express.json({ limit: '15mb' }));
  app.use(
    '/api',
    authRoutes(db, config, files, (tokenHash) => hub.endSession(tokenHash)),
  );

  const guard = requireAuth(db);
  app.use('/api/docs', guard, docRoutes(db));
  app.use('/api/media', guard, mediaRoutes(db, files));
  app.use('/api/chat', guard, chatRoutes(db, files, hub));
  app.use('/api/video', guard, videoRoutes(db, files, queue));
  app.use('/api', guard, toolRoutes(db, config));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Unknown API route')));

  if (existsSync(path.join(config.clientDir, 'index.html'))) {
    app.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', APP_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'same-origin');
      next();
    });
    app.use(
      express.static(config.clientDir, {
        index: false,
        setHeaders: (res, filePath) => {
          const hashed = /-[A-Z0-9]{8}\.\w+$/.test(filePath);
          res.setHeader(
            'Cache-Control',
            hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
          );
        },
      }),
    );
    app.get('/{*splat}', (req, res, next) => {
      // A missing asset must 404 rather than return the HTML shell.
      if (path.extname(req.path)) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile('index.html', { root: config.clientDir });
    });
  }

  app.use(errorHandler);

  const server = createServer(app);
  hub.attach(server, config);

  return {
    app,
    server,
    async close() {
      queue.close();
      hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}
