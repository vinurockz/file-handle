import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';

export async function startServer(overrides: Partial<Config> = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-test-'));
  const config = { ...loadConfig({}), dataDir, ...overrides };
  const studio = createApp(config);
  await new Promise<void>((resolve) => studio.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(studio.server.address() as AddressInfo).port}`;
  return {
    base,
    dataDir,
    async stop() {
      await studio.close();
      await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** A tiny cookie-keeping API client, one per simulated browser. */
export class Agent {
  cookie = '';
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  async request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const isForm = body instanceof FormData;
    const response = await fetch(this.base + url, {
      method,
      headers: {
        'X-Requested-With': 'studio',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    const raw = Buffer.from(await response.arrayBuffer());
    let data: any = raw;
    if (response.headers.get('content-type')?.includes('application/json'))
      data = JSON.parse(raw.toString() || 'null');
    return { status: response.status, data, headers: response.headers };
  }

  get = (url: string) => this.request('GET', url);
  post = (url: string, body: unknown = {}) => this.request('POST', url, body);
  put = (url: string, body: unknown) => this.request('PUT', url, body);
  del = (url: string) => this.request('DELETE', url);
}

export async function signUp(base: string, username: string) {
  const agent = new Agent(base);
  const result = await agent.post('/api/auth/register', {
    username,
    name: username,
    password: 'password123',
  });
  if (result.status !== 201) throw new Error(`register failed: ${JSON.stringify(result.data)}`);
  return { agent, userId: result.data.user.id as string };
}

export async function signUpWithWorkspace(base: string, username: string) {
  const user = await signUp(base, username);
  const workspace = (await user.agent.post('/api/workspaces', { name: `${username} space` })).data;
  await user.agent.post('/api/session/workspace', { workspaceId: workspace.id });
  return { ...user, workspaceId: workspace.id as string };
}

export function formWith(field: string, bytes: Uint8Array, name: string, type: string): FormData {
  const form = new FormData();
  form.append(field, new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), name);
  return form;
}

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhWMjWwAAAABJRU5ErkJggg==',
  'base64',
);
