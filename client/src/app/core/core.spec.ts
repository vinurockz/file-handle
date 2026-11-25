import { signal } from '@angular/core';
import type { Api } from './api';
import { CollectionStore, type Doc } from './collection';
import { History } from './history';
import { ProjectSaver, type Project } from './project';
import type { Ui } from './ui';
import { formatBytes, formatTime, moveItem, safeFilename, uniqueName } from './util';

type Note = Doc & { title: string; body: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

function fakeApi() {
  const calls: {
    method: string;
    url: string;
    body: unknown;
    reply: ReturnType<typeof deferred<unknown>>;
  }[] = [];
  const request = (method: string) => (url: string, body?: unknown) => {
    const reply = deferred<unknown>();
    calls.push({ method, url, body, reply });
    return reply.promise;
  };
  const api = {
    get: request('get'),
    post: request('post'),
    put: request('put'),
    delete: request('delete'),
  };
  return { api: api as unknown as Api, calls };
}

const errors = signal(0);
const ui = { error: () => errors.update((n) => n + 1) } as unknown as Ui;
const note = (id: string): Note => ({
  id,
  parentId: null,
  createdAt: 1,
  updatedAt: 1,
  title: 't',
  body: 'b',
});
const tick = () => new Promise((resolve) => setTimeout(resolve));

describe('CollectionStore', () => {
  const setup = () => {
    const { api, calls } = fakeApi();
    const store = new CollectionStore<Note>(api, ui, 'notes');
    store.items.set([note('1')]);
    return { store, calls };
  };

  it('updates at once and merges quick changes into one save', async () => {
    const { store, calls } = setup();
    store.patch('1', { title: 'a' }, 10_000);
    store.patch('1', { body: 'c' }, 10_000);
    expect(store.byId('1')).toMatchObject({ title: 'a', body: 'c' });
    expect(store.status()).toBe('saving');
    const done = store.flush('1');
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ title: 'a', body: 'c' });
    calls[0]!.reply.resolve({});
    expect(await done).toBe(true);
    expect(store.status()).toBe('saved');
  });

  it('never sends a newer save before the older one has finished', async () => {
    const { store, calls } = setup();
    store.patch('1', { title: 'first' }, 10_000);
    void store.flush('1');
    await tick();
    store.patch('1', { title: 'second' }, 10_000);
    const second = store.flush('1');
    await tick();
    expect(calls).toHaveLength(1);
    calls[0]!.reply.resolve({});
    await tick();
    expect(calls).toHaveLength(2);
    calls[1]!.reply.resolve({});
    await second;
    expect(store.status()).toBe('saved');
  });

  it('keeps failed changes and retries them without overwriting newer ones', async () => {
    const { store, calls } = setup();
    store.patch('1', { title: 'old', body: 'keep me' }, 10_000);
    const failed = store.flush('1');
    await tick();
    store.patch('1', { title: 'new' }, 10_000);
    calls[0]!.reply.reject(new Error('offline'));
    expect(await failed).toBe(false);
    expect(store.status()).toBe('error');
    const retry = store.flushAll();
    await tick();
    expect(calls[1]!.body).toEqual({ title: 'new', body: 'keep me' });
    calls[1]!.reply.resolve({});
    await retry;
    expect(store.status()).toBe('saved');
  });

  it('drops pending changes for a deleted document', async () => {
    const { store, calls } = setup();
    store.patch('1', { title: 'x' }, 10_000);
    const removal = store.remove('1');
    await tick();
    expect(calls.map((c) => c.method)).toEqual(['delete']);
    calls[0]!.reply.resolve(undefined);
    await removal;
    expect(store.items()).toEqual([]);
    expect(store.status()).toBe('saved');
  });

  it('ignores a slow load that finishes after a newer one', async () => {
    const { store, calls } = setup();
    const slow = store.load('a');
    const fast = store.load('b');
    calls[1]!.reply.resolve([note('b')]);
    await fast;
    calls[0]!.reply.resolve([note('a')]);
    await slow;
    expect(store.items().map((n) => n.id)).toEqual(['b']);
  });
});

describe('ProjectSaver', () => {
  it('creates once and then saves changes made while creating', async () => {
    const { api, calls } = fakeApi();
    const store = new CollectionStore<Project<number>>(api, ui, 'imageProjects');
    const saver = new ProjectSaver<number>(store, () => undefined);
    saver.save({ name: 'p', mediaId: null, doc: 1 });
    saver.save({ name: 'p', mediaId: null, doc: 2 });
    expect(calls).toHaveLength(1);
    calls[0]!.reply.resolve({
      id: 'x',
      parentId: null,
      createdAt: 1,
      updatedAt: 1,
      name: 'p',
      mediaId: null,
      doc: 1,
    });
    const flushed = saver.flush();
    await tick();
    expect(calls[1]).toMatchObject({
      method: 'put',
      url: '/docs/imageProjects/x',
      body: { doc: 2 },
    });
    calls[1]!.reply.resolve({});
    await flushed;
    expect(saver.projectId).toBe('x');
  });
});

describe('History', () => {
  it('undoes, redoes and clears the redo list after a new change', () => {
    const history = new History(0);
    history.commit(1);
    history.commit(2);
    history.undo();
    expect(history.value).toBe(1);
    history.redo();
    expect(history.value).toBe(2);
    history.undo();
    history.commit(5);
    expect(history.canRedo()).toBe(false);
    history.undo();
    expect(history.value).toBe(1);
  });

  it('records a whole drag as one step and can cancel it', () => {
    const history = new History(0);
    history.preview(1);
    history.preview(2);
    history.preview(3);
    history.commitPreview();
    history.undo();
    expect(history.value).toBe(0);
    history.preview(9);
    history.cancelPreview();
    expect(history.value).toBe(0);
  });

  it('merges rapid changes that share a key', () => {
    const history = new History(0);
    history.commit(1, 'slider');
    history.commit(2, 'slider');
    history.commit(3, 'slider');
    history.undo();
    expect(history.value).toBe(0);
  });
});

describe('utilities', () => {
  it('formats and sanitises', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatTime(65.25)).toBe('1:05.2');
    expect(formatTime(59.99)).toBe('0:59.9');
    expect(safeFilename('..\\a/b:c?.png')).toBe('_a_b_c_.png');
    const used = new Set<string>();
    expect([uniqueName('a.png', used), uniqueName('A.png', used)]).toEqual(['a.png', 'A (2).png']);
    expect(moveItem([1, 2, 3], 0, 99)).toEqual([2, 3, 1]);
  });
});
