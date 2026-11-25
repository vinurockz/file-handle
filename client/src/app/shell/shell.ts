import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Auth, photoUrl } from '../core/auth';
import { SaveRegistry } from '../core/collection';
import { Ui } from '../core/ui';
import { ChatStore } from '../features/chat/chat-store';
import { MODULES } from '../modules';

@Component({
  selector: 'app-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  host: { class: 'shell' },
  providers: [ChatStore],
  template: `
    <button
      type="button"
      class="btn nav-toggle no-print"
      aria-label="Open menu"
      [attr.aria-expanded]="open()"
      (click)="open.set(!open())"
    >
      ☰
    </button>
    <nav class="sidebar no-print" aria-label="Modules" [class.open]="open()">
      <a class="brand" routerLink="/files">◆ Studio</a>
      @for (group of groups; track group.name) {
        <p class="nav-group">{{ group.name }}</p>
        @for (module of group.modules; track module.path) {
          <a
            class="nav-link"
            [routerLink]="'/' + module.path"
            routerLinkActive="active"
            (click)="open.set(false)"
          >
            <span aria-hidden="true">{{ module.icon }}</span> {{ module.label }}
            @if (module.path === 'chat' && unread()) {
              <span class="pill" [attr.aria-label]="unread() + ' unread messages'">{{
                unread()
              }}</span>
            }
          </a>
        }
      }
      <div class="sidebar-foot">
        <span class="save-state" [class.error]="saves.failed()">
          {{
            saves.failed()
              ? '⚠ Some changes are not saved'
              : saves.busy()
                ? 'Saving…'
                : 'All changes saved'
          }}
        </span>
        @if (saves.failed()) {
          <button type="button" class="btn small" (click)="saves.flushAll()">Retry save</button>
        }
        <button type="button" class="nav-link" (click)="switchWorkspace()">
          @if (auth.workspace()?.hasPhoto) {
            <img class="avatar" [src]="photo(auth.workspace()!)" alt="" />
          } @else {
            <span class="dot" [style.background]="auth.workspace()?.color"></span>
          }
          <span class="truncate">{{ auth.workspace()?.name }}</span>
          <small>Switch</small>
        </button>
        <div class="row">
          <span class="avatar" [style.background]="auth.user()?.color">{{
            auth.user()?.name?.charAt(0)
          }}</span>
          <span class="grow truncate">{{ auth.user()?.name }}</span>
          <button type="button" class="btn small" (click)="signOut()">Sign out</button>
        </div>
      </div>
    </nav>
    <main class="main"><router-outlet /></main>
  `,
})
export class Shell implements OnInit {
  private readonly chat = inject(ChatStore);
  protected readonly unread = computed(() =>
    this.chat.conversations().reduce((sum, c) => sum + c.unread, 0),
  );
  protected readonly auth = inject(Auth);
  protected readonly photo = photoUrl;
  protected readonly saves = inject(SaveRegistry);
  private readonly ui = inject(Ui);
  private readonly router = inject(Router);
  protected readonly open = signal(false);
  protected readonly groups = [...new Set(MODULES.map((m) => m.group))].map((name) => ({
    name,
    modules: MODULES.filter((m) => m.group === name),
  }));

  ngOnInit(): void {
    this.chat.start();
  }

  protected switchWorkspace(): void {
    void this.router.navigateByUrl('/workspaces');
  }

  protected async signOut(): Promise<void> {
    try {
      await this.auth.logout();
    } catch (error) {
      this.ui.error(error);
    }
  }
}
