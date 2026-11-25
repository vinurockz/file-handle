import { Component, inject, input, OnInit, output, signal } from '@angular/core';
import { Api } from '../../core/api';
import { Ui } from '../../core/ui';
import type { User } from '../../core/auth';
import { Modal } from '../../shared/widgets';

export interface PeopleChoice {
  users: User[];
  groupName: string;
}

@Component({
  selector: 'app-people-picker',
  imports: [Modal],
  template: `
    <app-modal [heading]="addingTo() ? 'Add people' : 'New chat'" (closed)="closed.emit()">
      <input
        type="search"
        autofocus
        aria-label="Search people"
        placeholder="Search by name or username"
        (input)="search($any($event.target).value)"
      />
      <div class="people">
        @for (user of results(); track user.id) {
          <label class="check person">
            <input type="checkbox" [checked]="isChosen(user.id)" (change)="toggle(user)" />
            <span class="avatar" [style.background]="user.color">{{ user.name.charAt(0) }}</span>
            <span
              ><strong>{{ user.name }}</strong>
              <span class="muted">&#64;{{ user.username }}</span></span
            >
          </label>
        } @empty {
          <p class="muted">
            No other people found. Each person needs their own account on this server.
          </p>
        }
      </div>
      @if (chosen().length) {
        <div class="row wrap">
          @for (user of chosen(); track user.id) {
            <span class="chip">{{ user.name }}</span>
          }
        </div>
      }
      @if (!addingTo() && chosen().length > 1) {
        <label class="field"
          >Group name
          <input
            maxlength="80"
            [value]="groupName()"
            (input)="groupName.set($any($event.target).value)"
        /></label>
      }
      <div class="row end">
        <button type="button" class="btn" (click)="closed.emit()">Cancel</button>
        <button type="button" class="btn primary" [disabled]="!ready()" (click)="submit()">
          {{ addingTo() ? 'Add' : chosen().length > 1 ? 'Create group' : 'Start chat' }}
        </button>
      </div>
    </app-modal>
  `,
  styles: `
    .people {
      max-height: 300px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }
    .person {
      padding: 0.25rem;
    }
  `,
})
export class PeoplePicker implements OnInit {
  private readonly api = inject(Api);
  private readonly ui = inject(Ui);
  /** Member ids already in the group, when adding to an existing one. */
  readonly addingTo = input<string[] | null>(null);
  readonly picked = output<PeopleChoice>();
  readonly closed = output<void>();
  protected readonly results = signal<User[]>([]);
  protected readonly chosen = signal<User[]>([]);
  protected readonly groupName = signal('');
  private request = 0;

  ngOnInit(): void {
    this.search('');
  }

  protected async search(query: string): Promise<void> {
    const request = ++this.request;
    try {
      const users = await this.api.get<User[]>(`/chat/users?q=${encodeURIComponent(query)}`);
      if (request === this.request)
        this.results.set(users.filter((u) => !this.addingTo()?.includes(u.id)));
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected isChosen(id: string): boolean {
    return this.chosen().some((u) => u.id === id);
  }

  protected toggle(user: User): void {
    this.chosen.update((list) =>
      this.isChosen(user.id) ? list.filter((u) => u.id !== user.id) : [...list, user],
    );
  }

  protected ready(): boolean {
    const count = this.chosen().length;
    return count > 0 && (!!this.addingTo() || count === 1 || !!this.groupName().trim());
  }

  protected submit(): void {
    this.picked.emit({ users: this.chosen(), groupName: this.groupName().trim() });
  }
}
