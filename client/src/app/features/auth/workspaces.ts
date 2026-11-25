import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Auth, photoUrl, type Workspace } from '../../core/auth';
import { Ui } from '../../core/ui';
import { pickFiles } from '../../core/util';
import { Modal } from '../../shared/widgets';
import { initials } from './initials';

@Component({
  selector: 'app-workspaces',
  imports: [Modal, NgTemplateOutlet],
  templateUrl: './workspaces.html',
  styleUrl: './workspaces.scss',
})
export class Workspaces {
  protected readonly auth = inject(Auth);
  private readonly ui = inject(Ui);
  private readonly router = inject(Router);
  protected readonly busy = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly photo = photoUrl;
  protected readonly initialsOf = initials;
  protected readonly creating = signal(false);
  /** Id of the customer being opened, so only one can be opened at a time. */
  protected readonly opening = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly visible = computed(() => {
    const text = this.query().trim().toLocaleLowerCase();
    return this.auth
      .workspaces()
      .filter((w) => !text || `${w.name} ${w.description}`.toLocaleLowerCase().includes(text));
  });

  protected added(workspace: Workspace): string {
    return new Date(workspace.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
  }

  protected menu(event: MouseEvent, workspace: Workspace): void {
    this.ui.openMenu(event, [
      { label: 'Open', run: () => void this.enter(workspace.id) },
      { label: 'Edit', run: () => this.editingId.set(workspace.id) },
      { label: 'Delete', run: () => void this.remove(workspace), danger: true },
    ]);
  }

  protected editing(): Workspace | null {
    return this.auth.workspaces().find((w) => w.id === this.editingId()) ?? null;
  }

  protected async enter(id: string): Promise<void> {
    if (this.opening()) return;
    this.opening.set(id);
    await this.attempt(async () => {
      await this.auth.selectWorkspace(id);
      await this.router.navigateByUrl('/files');
    });
    this.opening.set(null);
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    await this.attempt(async () => {
      const workspace = await this.auth.createWorkspace(
        name,
        String(data.get('description') ?? ''),
      );
      form.reset();
      this.creating.set(false);
      await this.enter(workspace.id);
    });
    this.busy.set(false);
  }

  protected async save(event: Event, workspace: Workspace): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const name = String(data.get('name') ?? '').trim();
    if (!name) return;
    await this.attempt(async () => {
      await this.auth.updateWorkspace(workspace.id, name, String(data.get('description') ?? ''));
      this.editingId.set(null);
    });
  }

  protected async setPhoto(workspace: Workspace, choose: boolean): Promise<void> {
    const [file] = choose ? await pickFiles('image/*', false) : [];
    if (choose && !file) return;
    await this.attempt(() => this.auth.setWorkspacePhoto(workspace.id, file ?? null));
  }

  protected async remove(workspace: Workspace): Promise<void> {
    const sure = await this.ui.confirm(
      `Delete “${workspace.name}”?`,
      'All of its files and projects will be permanently deleted.',
    );
    if (sure) await this.attempt(() => this.auth.deleteWorkspace(workspace.id));
  }

  protected async signOut(): Promise<void> {
    await this.attempt(() => this.auth.logout());
  }

  private async attempt(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.ui.error(error);
    }
  }
}
