import { CdkDrag, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { Auth } from '../../core/auth';
import { injectCollection, type Doc } from '../../core/collection';
import { MediaLibrary, mediaUrl } from '../../core/media';
import { Ui } from '../../core/ui';
import { moveItem } from '../../core/util';
import { BlocksEditor, type Block } from '../../shared/blocks-editor';
import { Modal } from '../../shared/widgets';

interface Section extends Doc {
  title: string;
  color: string;
}

interface Task extends Doc {
  title: string;
  blocks: Block[];
  completed: boolean;
  priority: 'low' | 'medium' | 'high';
  dueDate: string;
}

const DEFAULT_SECTIONS = [
  { title: 'New tasks', color: '#6366f1' },
  { title: 'Completed', color: '#10b981' },
  { title: 'Pending', color: '#f59e0b' },
];

export const today = (now = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

@Component({
  selector: 'app-tasks',
  imports: [CdkDrag, CdkDropList, CdkDropListGroup, BlocksEditor, Modal],
  host: { class: 'page' },
  template: `
    <header class="page-head">
      <h1>Tasks</h1>
      <input
        type="search"
        aria-label="Search tasks"
        placeholder="Search tasks"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
      />
      <label class="check"
        ><input
          type="checkbox"
          [checked]="hideDone()"
          (change)="hideDone.set($any($event.target).checked)"
        />
        Hide completed</label
      >
      <button type="button" class="btn primary" (click)="addSection()">New section</button>
    </header>
    @if (!sections.loaded() || !tasks.loaded()) {
      <p class="empty">Loading board…</p>
    }
    <div class="board" cdkDropListGroup>
      @for (
        column of columns();
        track column.section.id;
        let i = $index;
        let first = $first;
        let last = $last
      ) {
        <section class="column">
          <header [style.background]="column.section.color">
            <button
              type="button"
              class="column-title"
              title="Rename section"
              (click)="renameSection(column.section)"
            >
              {{ column.section.title }} ({{ column.tasks.length }})
            </button>
            <input
              type="color"
              aria-label="Section colour"
              [value]="column.section.color"
              (input)="sections.patch(column.section.id, { color: $any($event.target).value })"
            />
            <button
              type="button"
              class="btn small"
              aria-label="Move section left"
              [disabled]="first"
              (click)="moveSection(i, -1)"
            >
              ←
            </button>
            <button
              type="button"
              class="btn small"
              aria-label="Move section right"
              [disabled]="last"
              (click)="moveSection(i, 1)"
            >
              →
            </button>
            <button
              type="button"
              class="btn small"
              aria-label="Delete section"
              (click)="removeSection(column.section)"
            >
              🗑
            </button>
          </header>
          <div
            class="cards"
            cdkDropList
            [cdkDropListData]="column"
            (cdkDropListDropped)="drop($event)"
          >
            @for (task of column.tasks; track task.id) {
              <article
                class="task"
                cdkDrag
                [cdkDragData]="task"
                [cdkDragStartDelay]="{ touch: 200, mouse: 0 }"
              >
                <input
                  type="checkbox"
                  [checked]="task.completed"
                  [attr.aria-label]="'Completed: ' + task.title"
                  (change)="tasks.patch(task.id, { completed: $any($event.target).checked }, 0)"
                />
                <button type="button" class="tile-open grow" (click)="openId.set(task.id)">
                  @if (coverOf(task); as cover) {
                    <img
                      class="task-cover"
                      [class.faded]="task.completed"
                      [src]="cover"
                      alt=""
                      loading="lazy"
                    />
                  }
                  <small class="status" [class.finished]="task.completed">{{
                    task.completed ? 'Completed' : 'Started'
                  }}</small>
                  <span [class.done]="task.completed">{{ task.title }}</span>
                  <span class="row wrap">
                    <span class="chip" [attr.data-priority]="task.priority">{{
                      task.priority
                    }}</span>
                    @if (task.dueDate) {
                      <span
                        class="chip"
                        [class.overdue]="!task.completed && task.dueDate < todayDate"
                        >📅 {{ task.dueDate }}</span
                      >
                    }
                  </span>
                </button>
              </article>
            }
          </div>
          <form class="row" (submit)="addTask($event, column.section.id)">
            <input
              class="grow"
              name="title"
              maxlength="200"
              placeholder="Add a task"
              [attr.aria-label]="'Add a task to ' + column.section.title"
            />
            <button type="submit" class="btn">Add</button>
          </form>
        </section>
      }
    </div>

    @if (open(); as task) {
      <app-modal heading="Task details" [wide]="true" (closed)="close(task.id)">
        <input
          aria-label="Task title"
          maxlength="200"
          [value]="task.title"
          (input)="tasks.patch(task.id, { title: $any($event.target).value })"
        />
        <div class="row wrap">
          <label class="check"
            ><input
              type="checkbox"
              [checked]="task.completed"
              (change)="tasks.patch(task.id, { completed: $any($event.target).checked })"
            />
            Completed</label
          >
          <label class="field"
            >Section
            <select (change)="moveTask(task, $any($event.target).value)">
              @for (section of sections.items(); track section.id) {
                <option [value]="section.id" [selected]="section.id === task.parentId">
                  {{ section.title }}
                </option>
              }
            </select>
          </label>
          <label class="field"
            >Priority
            <select (change)="tasks.patch(task.id, { priority: $any($event.target).value })">
              @for (level of priorities; track level) {
                <option [value]="level" [selected]="task.priority === level">{{ level }}</option>
              }
            </select>
          </label>
          <label class="field"
            >Due date
            <input
              type="date"
              [value]="task.dueDate"
              (change)="tasks.patch(task.id, { dueDate: $any($event.target).value })"
          /></label>
        </div>
        <app-blocks-editor
          [blocks]="task.blocks"
          uploadFolder="Task uploads"
          (changed)="tasks.patch(task.id, { blocks: $event })"
        />
        <div class="row end">
          <button type="button" class="btn danger" (click)="removeTask(task)">Delete task</button>
          <button type="button" class="btn primary" (click)="close(task.id)">Done</button>
        </div>
      </app-modal>
    }
  `,
  styles: `
    .board {
      display: flex;
      gap: 0.8rem;
      overflow-x: auto;
      align-items: flex-start;
      padding-bottom: 0.6rem;
    }
    .column {
      width: 300px;
      flex: none;
      background: var(--surface-2);
      border-radius: var(--radius);
      padding: 0.5rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-height: calc(100vh - 130px);
    }
    .column > header {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.35rem;
      border-radius: 8px;
    }
    .column-title {
      flex: 1;
      min-width: 0;
      text-align: left;
      font: inherit;
      font-weight: 700;
      color: #fff;
      text-shadow: 0 1px 2px rgb(0 0 0 / 55%);
      background: none;
      border: 0;
      cursor: pointer;
    }
    .cards {
      overflow-y: auto;
      min-height: 50px;
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
    }
    .task {
      display: flex;
      gap: 0.5rem;
      align-items: flex-start;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.5rem;
      cursor: grab;
    }
    .task .tile-open {
      min-height: 0;
    }
    .task-cover {
      width: 100%;
      height: 96px;
      object-fit: cover;
      border-radius: 6px;
    }
    .task-cover.faded {
      filter: grayscale(1);
      opacity: 0.7;
    }
    .status {
      text-transform: uppercase;
      font-weight: 700;
      font-size: 0.68rem;
      color: var(--accent);
    }
    .status.finished {
      color: var(--success);
    }
    .done {
      text-decoration: line-through;
      color: var(--muted);
    }
    .chip[data-priority='high'] {
      background: #fde2e4;
    }
    .chip[data-priority='low'] {
      background: #d9f5d6;
    }
    .overdue {
      background: var(--danger);
      color: #fff;
    }
  `,
})
export class Tasks implements OnInit {
  protected readonly sections = injectCollection<Section>('taskSections');
  protected readonly tasks = injectCollection<Task>('tasks');
  private readonly ui = inject(Ui);
  private readonly auth = inject(Auth);
  protected readonly query = signal('');
  protected readonly hideDone = signal(false);
  protected readonly openId = signal<string | null>(null);
  protected readonly open = computed(() => this.tasks.byId(this.openId()));
  protected readonly priorities = ['low', 'medium', 'high'] as const;
  protected readonly todayDate = today();
  private readonly library = inject(MediaLibrary);

  /** The first picture in the task's content, shown on its card. */
  protected coverOf(task: Task): string {
    for (const block of task.blocks) {
      if (block.type === 'media' && this.library.byId(block.mediaId)?.kind === 'image')
        return mediaUrl(block.mediaId);
    }
    return '';
  }
  protected readonly columns = computed(() => {
    const text = this.query().trim().toLowerCase();
    return this.sections.items().map((section) => ({
      section,
      tasks: this.tasks
        .items()
        .filter((t) => t.parentId === section.id)
        .filter((t) => !this.hideDone() || !t.completed)
        .filter((t) => !text || t.title.toLowerCase().includes(text)),
    }));
  });

  async ngOnInit(): Promise<void> {
    void this.library.load();
    await Promise.all([this.sections.load(), this.tasks.load()]);
    // A brand-new board gets starter columns; remember that so deleting them all sticks.
    if (!this.sections.loaded()) return;
    const seededKey = `studio:tasks-seeded:${this.auth.workspaceId()}`;
    if (
      !this.sections.items().length &&
      !this.tasks.items().length &&
      !localStorage.getItem(seededKey)
    ) {
      await this.attempt(async () => {
        for (const section of DEFAULT_SECTIONS) await this.sections.create(section);
      });
    }
    if (this.sections.items().length) localStorage.setItem(seededKey, '1');
  }

  private async attempt(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected async addSection(): Promise<void> {
    const title = await this.ui.prompt('Section name', '', 'Create');
    if (title) await this.attempt(() => this.sections.create({ title }));
  }

  protected async renameSection(section: Section): Promise<void> {
    const title = await this.ui.prompt('Rename section', section.title);
    if (title) this.sections.patch(section.id, { title }, 0);
  }

  protected moveSection(index: number, by: number): void {
    const ids = this.sections.items().map((s) => s.id);
    void this.sections.reorder(moveItem(ids, index, index + by));
  }

  protected async removeSection(section: Section): Promise<void> {
    const count = this.tasks.items().filter((t) => t.parentId === section.id).length;
    const sure = await this.ui.confirm(
      `Delete “${section.title}”?`,
      count ? `Its ${count} task(s) will be deleted too.` : '',
    );
    if (!sure) return;
    await this.attempt(async () => {
      await this.sections.remove(section.id);
      this.tasks.items.update((list) => list.filter((t) => t.parentId !== section.id));
    });
  }

  protected async addTask(event: Event, sectionId: string): Promise<void> {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const title = String(new FormData(form).get('title') ?? '').trim();
    if (!title) return;
    form.reset();
    await this.attempt(() => this.tasks.create({ title, parentId: sectionId }));
  }

  protected async moveTask(task: Task, sectionId: string): Promise<void> {
    if (sectionId === task.parentId) return;
    this.tasks.patch(task.id, { parentId: sectionId } as Partial<Task>, 0);
    if (await this.tasks.flush(task.id)) {
      // The server appends a moved task, so mirror that order locally.
      this.tasks.items.update((list) => [
        ...list.filter((t) => t.id !== task.id),
        list.find((t) => t.id === task.id)!,
      ]);
    }
  }

  protected async drop(event: CdkDragDrop<{ section: Section; tasks: Task[] }>): Promise<void> {
    const task = event.item.data as Task;
    const target = event.container.data;
    // Positions are computed against the visible cards, then applied to the full section.
    const visible = target.tasks.filter((t) => t.id !== task.id);
    const before = visible[event.currentIndex];
    if (task.parentId !== target.section.id) await this.moveTask(task, target.section.id);
    const ids = this.tasks
      .items()
      .filter((t) => t.parentId === target.section.id && t.id !== task.id)
      .map((t) => t.id);
    const at = before ? ids.indexOf(before.id) : ids.length;
    ids.splice(at < 0 ? ids.length : at, 0, task.id);
    await this.tasks.reorder(ids);
  }

  protected close(id: string): void {
    this.openId.set(null);
    void this.tasks.flush(id);
  }

  protected async removeTask(task: Task): Promise<void> {
    if (!(await this.ui.confirm(`Delete “${task.title}”?`))) return;
    await this.attempt(async () => {
      await this.tasks.remove(task.id);
      this.openId.set(null);
    });
  }
}
