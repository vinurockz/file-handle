import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { activeWorkspace, Api } from './api';
import { SaveRegistry } from './collection';
import { MediaLibrary } from './media';
import { Ui } from './ui';

export interface User {
  id: string;
  username: string;
  name: string;
  color: string;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  color: string;
  hasPhoto: boolean;
  createdAt: number;
  updatedAt: number;
}

export const photoUrl = (workspace: Workspace): string =>
  `/api/workspaces/${workspace.id}/photo?v=${workspace.updatedAt}`;

interface Session {
  user: User | null;
  workspaceId: string | null;
}

@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly api = inject(Api);
  private readonly ui = inject(Ui);
  private readonly media = inject(MediaLibrary);
  private readonly saves = inject(SaveRegistry);
  private readonly router = inject(Router);

  readonly user = signal<User | null>(null);
  readonly workspaces = signal<Workspace[]>([]);
  readonly workspaceId = signal<string | null>(null);
  readonly workspace = computed(
    () => this.workspaces().find((w) => w.id === this.workspaceId()) ?? null,
  );
  private ready: Promise<void> | null = null;

  constructor() {
    effect(() => activeWorkspace.set(this.workspaceId()));
  }

  /** Restores the session once; a failed attempt is retried on the next navigation. */
  init(): Promise<void> {
    this.ready ??= this.api
      .get<Session>('/auth/me')
      .then((session) => this.apply(session))
      .catch((error: unknown) => {
        this.ready = null;
        this.ui.error(error);
      });
    return this.ready;
  }

  async login(username: string, password: string): Promise<void> {
    await this.apply(await this.api.post<Session>('/auth/login', { username, password }));
  }

  async register(username: string, name: string, password: string): Promise<void> {
    await this.apply(await this.api.post<Session>('/auth/register', { username, name, password }));
  }

  async logout(): Promise<void> {
    await this.saves.flushAll();
    try {
      await this.api.post('/auth/logout');
    } finally {
      this.expire();
    }
  }

  expire(): void {
    this.ui.closeAll();
    this.media.reset();
    this.saves.clear();
    activeWorkspace.set(null);
    this.user.set(null);
    this.workspaces.set([]);
    this.workspaceId.set(null);
    this.ready = Promise.resolve();
    void this.router.navigateByUrl('/login');
  }

  async selectWorkspace(id: string | null): Promise<void> {
    await this.saves.flushAll();
    await this.api.post('/session/workspace', { workspaceId: id });
    this.media.reset();
    this.workspaceId.set(id);
    // Set directly as well: the next request may be made before effects run.
    activeWorkspace.set(id);
  }

  async createWorkspace(name: string, description: string): Promise<Workspace> {
    const workspace = await this.api.post<Workspace>('/workspaces', { name, description });
    this.workspaces.update((list) => [...list, workspace]);
    return workspace;
  }

  async updateWorkspace(id: string, name: string, description: string): Promise<void> {
    const updated = await this.api.put<Workspace>(`/workspaces/${id}`, { name, description });
    this.workspaces.update((list) => list.map((w) => (w.id === id ? updated : w)));
  }

  async setWorkspacePhoto(id: string, photo: File | null): Promise<void> {
    let updated: Workspace;
    if (photo) {
      const form = new FormData();
      form.append('file', photo, photo.name);
      updated = await this.api.post<Workspace>(`/workspaces/${id}/photo`, form);
    } else {
      updated = await this.api.send<Workspace>('delete', `/workspaces/${id}/photo`);
    }
    this.workspaces.update((list) => list.map((w) => (w.id === id ? updated : w)));
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.api.delete(`/workspaces/${id}`);
    this.workspaces.update((list) => list.filter((w) => w.id !== id));
    if (this.workspaceId() === id) this.workspaceId.set(null);
  }

  private async apply(session: Session): Promise<void> {
    this.media.reset();
    this.workspaces.set(session.user ? await this.api.get<Workspace[]>('/workspaces') : []);
    this.user.set(session.user);
    this.workspaceId.set(session.workspaceId);
    activeWorkspace.set(session.workspaceId);
    this.ready = Promise.resolve();
  }
}

export const signedIn: CanActivateFn = async () => {
  const auth = inject(Auth);
  const router = inject(Router);
  await auth.init();
  return auth.user() ? true : router.parseUrl('/login');
};

export const signedOut: CanActivateFn = async () => {
  const auth = inject(Auth);
  const router = inject(Router);
  await auth.init();
  return auth.user() ? router.parseUrl('/files') : true;
};

export const inWorkspace: CanActivateFn = async () => {
  const auth = inject(Auth);
  const router = inject(Router);
  await auth.init();
  if (!auth.user()) return router.parseUrl('/login');
  return auth.workspaceId() ? true : router.parseUrl('/workspaces');
};
