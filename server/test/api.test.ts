import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, formWith, PNG, signUp, signUpWithWorkspace, startServer } from './helpers.ts';
import { isBlockedAddress } from '../src/proxy.ts';
import { sniff } from '../src/files.ts';

let server: Awaited<ReturnType<typeof startServer>>;
let alice: Awaited<ReturnType<typeof signUpWithWorkspace>>;
let mallory: Awaited<ReturnType<typeof signUpWithWorkspace>>;

before(async () => {
  server = await startServer();
  alice = await signUpWithWorkspace(server.base, 'alice');
  mallory = await signUpWithWorkspace(server.base, 'mallory');
});
after(() => server.stop());

describe('auth', () => {
  test('rejects writes without the CSRF header', async () => {
    const response = await fetch(`${server.base}/api/auth/login`, { method: 'POST' });
    assert.equal(response.status, 403);
  });

  test('rejects anonymous access, duplicate names and wrong passwords', async () => {
    const anon = new Agent(server.base);
    assert.equal((await anon.get('/api/docs/notes')).status, 401);
    const duplicate = await anon.post('/api/auth/register', {
      username: 'ALICE',
      name: 'x',
      password: 'password123',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      (await anon.post('/api/auth/login', { username: 'alice', password: 'nope-nope' })).status,
      401,
    );
  });

  test('logout invalidates the session cookie', async () => {
    const { agent } = await signUp(server.base, 'leaver');
    const cookie = agent.cookie;
    assert.equal((await agent.post('/api/auth/logout')).status, 204);
    agent.cookie = cookie;
    assert.equal((await agent.get('/api/workspaces')).status, 401);
  });

  test('refuses writes from a tab that is showing a different workspace', async () => {
    const stale = await alice.agent.request(
      'POST',
      '/api/docs/notes',
      { title: 'x' },
      { 'X-Workspace': mallory.workspaceId },
    );
    assert.equal(stale.status, 409);
    const current = await alice.agent.request('GET', '/api/docs/notes', undefined, {
      'X-Workspace': alice.workspaceId,
    });
    assert.equal(current.status, 200);
  });

  test('cannot enter another user’s workspace', async () => {
    const result = await mallory.agent.post('/api/session/workspace', {
      workspaceId: alice.workspaceId,
    });
    assert.equal(result.status, 404);
  });
});

describe('documents', () => {
  test('a partial update keeps untouched fields', async () => {
    const note = (
      await alice.agent.post('/api/docs/notes', { title: 'Keep', pinned: true, labels: ['a'] })
    ).data;
    const updated = (await alice.agent.put(`/api/docs/notes/${note.id}`, { color: '#ff0000' }))
      .data;
    assert.equal(updated.title, 'Keep');
    assert.equal(updated.pinned, true);
    assert.deepEqual(updated.labels, ['a']);
    assert.equal(updated.color, '#ff0000');
  });

  test('another workspace cannot read, change or delete a document', async () => {
    const note = (await alice.agent.post('/api/docs/notes', { title: 'secret' })).data;
    const url = `/api/docs/notes/${note.id}`;
    assert.equal((await mallory.agent.get(url)).status, 404);
    assert.equal((await mallory.agent.put(url, { title: 'pwned' })).status, 404);
    assert.equal((await mallory.agent.del(url)).status, 404);
  });

  test('unknown collections and invalid values are rejected', async () => {
    assert.equal((await alice.agent.get('/api/docs/__proto__')).status, 404);
    assert.equal((await alice.agent.post('/api/docs/tasks', { title: 'no parent' })).status, 400);
    assert.equal(
      (await alice.agent.post('/api/docs/customEndpoints', { path: '../x' })).status,
      400,
    );
  });

  test('book page limit is enforced and deleting a book removes its pages', async () => {
    const book = (await alice.agent.post('/api/docs/books', { title: 'B', pageLimit: 1 })).data;
    assert.equal(
      (await alice.agent.post('/api/docs/bookPages', { parentId: book.id })).status,
      201,
    );
    assert.equal(
      (await alice.agent.post('/api/docs/bookPages', { parentId: book.id })).status,
      400,
    );
    await alice.agent.del(`/api/docs/books/${book.id}`);
    assert.deepEqual((await alice.agent.get(`/api/docs/bookPages?parentId=${book.id}`)).data, []);
  });

  test('a parent from another workspace is refused', async () => {
    const section = (await alice.agent.post('/api/docs/taskSections', { title: 'A' })).data;
    assert.equal(
      (await mallory.agent.post('/api/docs/tasks', { parentId: section.id })).status,
      400,
    );
  });

  test('reorder and move append to the end', async () => {
    const one = (await alice.agent.post('/api/docs/taskSections', { title: 'one' })).data;
    const a = (await alice.agent.post('/api/docs/tasks', { parentId: one.id, title: 'a' })).data;
    const b = (await alice.agent.post('/api/docs/tasks', { parentId: one.id, title: 'b' })).data;
    await alice.agent.post('/api/docs/tasks/reorder', { ids: [b.id, a.id] });
    const titles = (await alice.agent.get(`/api/docs/tasks?parentId=${one.id}`)).data.map(
      (t: any) => t.title,
    );
    assert.deepEqual(titles, ['b', 'a']);
  });

  test('folders cannot form cycles and deleting one keeps its contents', async () => {
    const root = (await alice.agent.post('/api/docs/folders', { name: 'root' })).data;
    const child = (
      await alice.agent.post('/api/docs/folders', { name: 'child', folderParentId: root.id })
    ).data;
    const cycle = await alice.agent.put(`/api/docs/folders/${root.id}`, {
      folderParentId: child.id,
    });
    assert.equal(cycle.status, 400);
    const form = formWith('file', PNG, 'dot.png', 'image/png');
    form.append('folderId', child.id);
    const media = (await alice.agent.post('/api/media', form)).data;
    await alice.agent.del(`/api/docs/folders/${child.id}`);
    const after = (await alice.agent.get('/api/media')).data.find((m: any) => m.id === media.id);
    assert.equal(after.folderId, root.id);
  });
});

describe('media', () => {
  test('detects type from content, not the declared type', async () => {
    const html = formWith('file', Buffer.from('<script>alert(1)</script>'), 'x.png', 'image/png');
    assert.equal((await alice.agent.post('/api/media', html)).status, 415);
    assert.equal(sniff(Buffer.from('<svg xmlns="x">')).kind, 'other');
  });

  test('upload keeps unicode names, serves safely, and is private', async () => {
    const media = (
      await alice.agent.post('/api/media', formWith('file', PNG, 'फोटो.png', 'image/png'))
    ).data;
    assert.equal(media.title, 'फोटो');
    const file = await alice.agent.get(`/api/media/${media.id}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(file.data, PNG);
    assert.equal((await mallory.agent.get(`/api/media/${media.id}/file`)).status, 404);
    assert.equal((await mallory.agent.del(`/api/media/${media.id}`)).status, 404);
    assert.equal((await alice.agent.del(`/api/media/${media.id}`)).status, 204);
  });
});

describe('chat', () => {
  test('full conversation lifecycle with permissions', async () => {
    const ann = await signUp(server.base, 'ann');
    const ben = await signUp(server.base, 'ben');
    const eve = await signUp(server.base, 'eve');

    const created = await ann.agent.post('/api/chat/conversations', {
      type: 'direct',
      memberIds: [ben.userId],
    });
    assert.equal(created.status, 201);
    const again = await ben.agent.post('/api/chat/conversations', {
      type: 'direct',
      memberIds: [ann.userId],
    });
    assert.equal(again.data.id, created.data.id, 'direct chats are not duplicated');
    const url = `/api/chat/conversations/${created.data.id}`;

    assert.equal((await eve.agent.get(`${url}/messages`)).status, 404);
    assert.equal((await eve.agent.post(`${url}/messages`, { text: 'hi' })).status, 404);

    const upload = (
      await ann.agent.post(`${url}/files`, formWith('file', PNG, 'p.png', 'image/png'))
    ).data;
    assert.equal(
      (await ben.agent.get(`/api/chat/files/${upload.id}`)).status,
      404,
      'unsent uploads are private',
    );
    const stolen = await ben.agent.post(`${url}/messages`, { fileIds: [upload.id] });
    assert.equal(stolen.status, 400);
    assert.deepEqual(
      (await ben.agent.get(`${url}/messages`)).data.messages,
      [],
      'failed send leaves nothing behind',
    );

    const sent = (await ann.agent.post(`${url}/messages`, { text: 'hello', fileIds: [upload.id] }))
      .data;
    assert.equal(sent.attachments.length, 1);
    assert.equal((await ben.agent.get(`/api/chat/files/${upload.id}`)).status, 200);
    assert.equal((await eve.agent.get(`/api/chat/files/${upload.id}`)).status, 404);
    assert.equal((await ben.agent.get('/api/chat/conversations')).data[0].unread, 1);
    await ben.agent.post(`${url}/read`, { seq: sent.seq });
    assert.equal((await ben.agent.get('/api/chat/conversations')).data[0].unread, 0);

    assert.equal((await ben.agent.put(`${url}/messages/${sent.id}`, { text: 'x' })).status, 403);
    assert.equal((await ben.agent.del(`${url}/messages/${sent.id}`)).status, 403);
    const edited = (await ann.agent.put(`${url}/messages/${sent.id}`, { text: 'edited' })).data;
    assert.equal(edited.text, 'edited');
    assert.ok(edited.editedAt);

    const reacted = (await ben.agent.post(`${url}/messages/${sent.id}/reactions`, { emoji: '👍' }))
      .data;
    assert.equal(reacted.reactions.length, 1);
    const unreacted = (
      await ben.agent.post(`${url}/messages/${sent.id}/reactions`, { emoji: '👍' })
    ).data;
    assert.equal(unreacted.reactions.length, 0);

    const deleted = (await ann.agent.del(`${url}/messages/${sent.id}`)).data;
    assert.equal(deleted.text, '');
    assert.deepEqual(deleted.attachments, []);
    assert.equal((await ben.agent.get(`/api/chat/files/${upload.id}`)).status, 404);
    assert.equal((await ann.agent.put(`${url}/messages/${sent.id}`, { text: 'back' })).status, 404);
  });

  test('group admin rules and live events', async () => {
    const owner = await signUp(server.base, 'owner1');
    const guest = await signUp(server.base, 'guest1');
    const group = (
      await owner.agent.post('/api/chat/conversations', {
        type: 'group',
        name: 'Team',
        memberIds: [guest.userId],
      })
    ).data;
    const url = `/api/chat/conversations/${group.id}`;
    assert.equal((await guest.agent.put(url, { name: 'Mine' })).status, 403);

    const socket = new WebSocket(`${server.base.replace('http', 'ws')}/ws`, {
      headers: { Cookie: guest.agent.cookie, Origin: server.base },
    } as any);
    const events: any[] = [];
    const received = (type: string) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${type} event`)), 3000);
        const poll = setInterval(() => {
          const found = events.find((e) => e.type === type);
          if (found) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve(found);
          }
        }, 10);
      });
    socket.addEventListener('message', (e) => events.push(JSON.parse(String(e.data))));
    await received('ready');
    await owner.agent.post(`${url}/messages`, { text: 'live' });
    assert.equal((await received('message')).message.text, 'live');

    await owner.agent.del(`${url}/members/${guest.userId}`);
    await received('conversation-removed');
    events.length = 0;
    await owner.agent.post(`${url}/messages`, { text: 'after removal' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(events.filter((e) => e.type === 'message').length, 0);
    socket.close();
    assert.equal((await owner.agent.del(`${url}/members/${owner.userId}`)).status, 204);
  });

  test('websocket rejects foreign origins', async () => {
    const socket = new WebSocket(`${server.base.replace('http', 'ws')}/ws`, {
      headers: { Cookie: alice.agent.cookie, Origin: 'https://evil.example' },
    } as any);
    const outcome = await new Promise((resolve) => {
      socket.addEventListener('open', () => resolve('open'));
      socket.addEventListener('error', () => resolve('rejected'));
    });
    assert.equal(outcome, 'rejected');
  });
});

describe('tools', () => {
  test('SSRF rules', () => {
    assert.equal(isBlockedAddress('169.254.169.254', true), true);
    assert.equal(isBlockedAddress('::ffff:169.254.169.254', true), true);
    assert.equal(isBlockedAddress('127.0.0.1', false), true);
    assert.equal(isBlockedAddress('::ffff:10.0.0.1', false), true);
    assert.equal(isBlockedAddress('127.0.0.1', true), false);
    assert.equal(isBlockedAddress('8.8.8.8', false), false);
  });

  test('proxy forwards requests and follows redirects when private targets are allowed', async () => {
    const target = createServer((req, res) => {
      if (req.url === '/go') {
        res.writeHead(302, { Location: '/end' }).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`${req.method} ${req.url}`);
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const port = (target.address() as AddressInfo).port;
    for (const host of ['127.0.0.1', 'localhost']) {
      const result = await alice.agent.post('/api/api-tester/send', {
        method: 'GET',
        url: `http://${host}:${port}/go`,
      });
      assert.equal(result.data.status, 200, JSON.stringify(result.data));
      assert.equal(Buffer.from(result.data.bodyBase64, 'base64').toString(), 'GET /end');
    }
    const metadata = await alice.agent.post('/api/api-tester/send', {
      method: 'GET',
      url: 'http://169.254.169.254/',
    });
    assert.equal(metadata.status, 403);
    const file = await alice.agent.post('/api/api-tester/send', {
      method: 'GET',
      url: 'file:///etc/passwd',
    });
    assert.equal(file.status, 400);
    target.close();
  });

  test('mock endpoints are public, sandboxed and unique', async () => {
    const body = {
      name: 'm',
      method: 'GET',
      path: 'users/list',
      contentType: 'text/html',
      body: '<b>hi</b>',
    };
    const endpoint = (await alice.agent.post('/api/docs/customEndpoints', body)).data;
    assert.equal((await alice.agent.post('/api/docs/customEndpoints', body)).status, 409);
    const url = `${server.base}/api/mock/${alice.workspaceId}/users/list`;
    const response = await fetch(url);
    assert.equal(await response.text(), '<b>hi</b>');
    assert.equal(response.headers.get('content-security-policy'), 'sandbox');
    await alice.agent.put(`/api/docs/customEndpoints/${endpoint.id}`, { enabled: false });
    assert.equal((await fetch(url)).status, 404);
  });

  test('reports reflect workspace data', async () => {
    const report = (await mallory.agent.get('/api/reports/summary')).data;
    assert.equal(report.storage.totalCount, 0);
    assert.equal(report.modules.find((m: any) => m.label === 'Notes').stats.notes, 0);
  });
});
