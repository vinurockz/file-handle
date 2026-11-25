import { Component, effect, inject, untracked } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { sessionExpired } from './core/api';
import { Auth } from './core/auth';
import { SaveRegistry } from './core/collection';
import { Overlays } from './shared/overlays';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Overlays],
  template: '<router-outlet /><app-overlays />',
  host: {
    '(window:beforeunload)': 'warnUnsaved($event)',
    '(document:visibilitychange)': 'flushWhenHidden()',
    '(window:dragover)': 'guardDrop($event)',
    '(window:drop)': 'guardDrop($event)',
  },
})
export class App {
  private readonly auth = inject(Auth);
  private readonly saves = inject(SaveRegistry);

  constructor() {
    effect(() => {
      if (sessionExpired() === 0) return;
      untracked(() => {
        if (this.auth.user()) this.auth.expire();
      });
    });
  }

  protected warnUnsaved(event: BeforeUnloadEvent): void {
    if (!this.saves.busy()) return;
    void this.saves.flushAll();
    event.preventDefault();
  }

  /** A file dropped outside a drop zone would otherwise replace the app with that file. */
  protected guardDrop(event: DragEvent): void {
    if (event.defaultPrevented || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'none';
  }

  protected flushWhenHidden(): void {
    if (document.visibilityState === 'hidden') void this.saves.flushAll();
  }
}
