import type { CollectionStore, Doc } from './collection';

export interface Project<TDoc = unknown> extends Doc {
  name: string;
  mediaId: string | null;
  doc: TDoc;
  status?: 'draft' | 'done';
}

export interface ProjectData<TDoc> {
  name: string;
  mediaId: string | null;
  doc: TDoc;
  status?: 'draft' | 'done';
}

/**
 * Autosaves an editor's work as a resumable project. The project is only created on the first change,
 * and changes made while that first request is still running are not lost.
 */
export class ProjectSaver<TDoc> {
  private id: string | null = null;
  private latest: ProjectData<TDoc> | null = null;
  private creating: Promise<void> | null = null;
  private generation = 0;
  private readonly store: CollectionStore<Project<TDoc>>;
  private readonly onError: (error: unknown) => void;

  constructor(store: CollectionStore<Project<TDoc>>, onError: (error: unknown) => void) {
    this.store = store;
    this.onError = onError;
  }

  get projectId(): string | null {
    return this.id;
  }

  /** Switches to another piece of work, saving what is pending for the current one. */
  open(projectId: string | null): void {
    if (this.id) void this.store.flush(this.id);
    this.generation++;
    this.id = projectId;
    this.latest = null;
    this.creating = null;
  }

  save(data: ProjectData<TDoc>): void {
    this.latest = data;
    if (this.id) {
      this.store.patch(this.id, data as Partial<Project<TDoc>>, 900);
      return;
    }
    if (this.creating) return;
    const generation = this.generation;
    const sent = data;
    this.creating = this.store.create(sent as Partial<Project<TDoc>>).then(
      (project) => {
        const stale = generation !== this.generation;
        const newest = stale ? null : this.latest;
        if (!stale) {
          this.id = project.id;
          this.creating = null;
        }
        if (newest && newest !== sent)
          this.store.patch(project.id, newest as Partial<Project<TDoc>>, 900);
      },
      (error: unknown) => {
        if (generation === this.generation) this.creating = null;
        this.onError(error);
      },
    );
  }

  /** Resolves once everything handed to `save` has reached the server (or failed). */
  async flush(): Promise<void> {
    await this.creating;
    if (this.id) await this.store.flush(this.id);
  }
}
