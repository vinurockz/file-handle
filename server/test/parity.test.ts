import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../src/db.ts';
import { Agent, formWith, PNG, signUp, signUpWithWorkspace, startServer } from './helpers.ts';

let server: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  server = await startServer();
});
after(() => server.stop());

const picture = () => formWith('file', PNG, 'cover.png', 'image/png');

test('customer photos: pictures only, private to the owner, removable', async () => {
  const owner = await signUpWithWorkspace(server.base, 'photo_owner');
  const other = await signUpWithWorkspace(server.base, 'photo_other');
  const url = `/api/workspaces/${owner.workspaceId}/photo`;
  const notPicture = formWith('file', Buffer.from('%PDF-1.7 hello'), 'a.png', 'image/png');
  assert.equal((await owner.agent.post(url, notPicture)).status, 415);
  assert.equal((await other.agent.post(url, picture())).status, 404);
  assert.equal((await owner.agent.post(url, picture())).data.hasPhoto, true);
  assert.deepEqual((await owner.agent.get(url)).data, PNG);
  assert.equal((await other.agent.get(url)).status, 404);
  assert.equal((await owner.agent.del(url)).data.hasPhoto, false);
  assert.equal((await owner.agent.get(url)).status, 404);
});

test('group description and picture are for members; only admins change them', async () => {
  const admin = await signUp(server.base, 'g_admin');
  const member = await signUp(server.base, 'g_member');
  const outsider = await signUp(server.base, 'g_outsider');
  const group = (
    await admin.agent.post('/api/chat/conversations', {
      type: 'group',
      name: 'G',
      memberIds: [member.userId],
    })
  ).data;
  const url = `/api/chat/conversations/${group.id}`;
  const described = (await admin.agent.put(url, { description: 'About us' })).data;
  assert.equal(described.description, 'About us');
  assert.equal(described.name, 'G', 'a partial update keeps the name');
  assert.equal((await member.agent.post(`${url}/image`, picture())).status, 403);
  assert.ok((await admin.agent.post(`${url}/image`, picture())).data.imageVersion);
  assert.equal((await member.agent.get(`${url}/image`)).status, 200);
  assert.equal((await outsider.agent.get(`${url}/image`)).status, 404);
  assert.equal((await admin.agent.del(`${url}/image`)).data.imageVersion, null);
});

test('saved edits default to draft and can be marked done', async () => {
  const user = await signUpWithWorkspace(server.base, 'drafts');
  const project = (await user.agent.post('/api/docs/imageProjects', { name: 'p', doc: {} })).data;
  assert.equal(project.status, 'draft');
  const done = await user.agent.put(`/api/docs/imageProjects/${project.id}`, { status: 'done' });
  assert.equal(done.data.status, 'done');
});

test('an older database is upgraded without losing rows', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'studio-migrate-'));
  const old = new DatabaseSync(path.join(dir, 'studio.db'));
  old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, name TEXT, color TEXT, passwordHash TEXT, createdAt INTEGER);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT, name TEXT, directKey TEXT UNIQUE, createdAt INTEGER, updatedAt INTEGER);
    INSERT INTO conversations VALUES ('c1', 'group', 'Old group', NULL, 1, 1);`);
  old.close();
  const upgraded = new Db(dir);
  const row = upgraded.get<{ name: string; description: string }>(
    "SELECT * FROM conversations WHERE id = 'c1'",
  )!;
  assert.equal(row.name, 'Old group');
  assert.equal(row.description, '');
  upgraded.close();
  new Db(dir).close();
  await rm(dir, { recursive: true, force: true });
});

test('Google sign-in stays off until configured', async () => {
  const agent = new Agent(server.base);
  assert.deepEqual((await agent.get('/api/auth/google/status')).data, { configured: false });
  assert.equal((await agent.get('/api/auth/google/start')).status, 501);
});

test('Google sign-in checks state, creates one account and never takes over a local one', async () => {
  const calls: string[] = [];
  const configured = await startServer({
    google: { clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost/cb' },
    oauthFetch: (async (url: string) => {
      calls.push(url);
      return Response.json(
        url.includes('/token')
          ? { access_token: 't' }
          : { sub: 'google-1', email: 'taken@example.com', email_verified: true, name: 'G User' },
      );
    }) as typeof fetch,
  });
  try {
    await signUp(configured.base, 'taken');
    const go = (route: string, cookie = '') =>
      fetch(configured.base + route, {
        redirect: 'manual',
        headers: cookie ? { Cookie: cookie } : {},
      });
    const signIn = async () => {
      const start = await go('/api/auth/google/start');
      assert.equal(start.status, 302);
      const target = new URL(start.headers.get('location')!);
      assert.equal(target.hostname, 'accounts.google.com');
      const stateCookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
      return { state: target.searchParams.get('state')!, stateCookie };
    };
    const first = await signIn();
    const forged = await go('/api/auth/google/callback?code=x&state=wrong', first.stateCookie);
    assert.equal(forged.status, 400);
    assert.equal(calls.length, 0, 'nothing is sent to Google for a forged request');

    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const attempt = await signIn();
      const done = await go(
        `/api/auth/google/callback?code=x&state=${attempt.state}`,
        attempt.stateCookie,
      );
      assert.equal(done.status, 302);
      const session = done.headers.getSetCookie().find((c) => c.startsWith('studio_session='))!;
      const me = (await (await go('/api/auth/me', session.split(';')[0])).json()) as {
        user: { id: string; username: string };
      };
      assert.notEqual(me.user.username, 'taken');
      ids.push(me.user.id);
    }
    assert.equal(ids[0], ids[1]);
    const noPassword = await new Agent(configured.base).post('/api/auth/login', {
      username: 'taken2',
      password: '',
    });
    assert.equal(noPassword.status, 401);
  } finally {
    await configured.stop();
  }
});

test('every video effect renders with FFmpeg', async () => {
  const user = await signUpWithWorkspace(server.base, 'effects');
  const media = (await user.agent.post('/api/media', formWith('file', PNG, 'p.png', 'image/png')))
    .data;
  const form = new FormData();
  form.append(
    'spec',
    JSON.stringify({
      width: 320,
      height: 240,
      fps: 10,
      clips: [
        {
          mediaId: media.id,
          end: 0.5,
          hue: 90,
          sepia: 0.7,
          invert: true,
          pixelate: 12,
          vignette: 0.8,
        },
      ],
    }),
  );
  const created = await user.agent.post('/api/video/jobs', form);
  assert.equal(created.status, 202, JSON.stringify(created.data));
  let job = created.data;
  while (job.status === 'queued' || job.status === 'running') {
    await new Promise((r) => setTimeout(r, 100));
    job = (await user.agent.get(`/api/video/jobs/${job.id}`)).data;
  }
  assert.equal(job.status, 'done', job.error);
});
