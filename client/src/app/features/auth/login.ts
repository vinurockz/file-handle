import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';

@Component({
  selector: 'app-login',
  host: { class: 'centered' },
  template: `
    <form class="card auth-card" (submit)="submit($event)">
      <h1>◆ Studio</h1>
      <p class="muted">{{ registering() ? 'Create your account' : 'Sign in to continue' }}</p>
      @if (registering()) {
        <label class="field"
          >Your name <input name="name" autocomplete="name" required maxlength="60"
        /></label>
      }
      <label class="field"
        >Username
        <input name="username" autocomplete="username" required minlength="3" maxlength="32"
      /></label>
      <label class="field">
        Password
        <input
          name="password"
          type="password"
          required
          [attr.minlength]="registering() ? 8 : 1"
          [autocomplete]="registering() ? 'new-password' : 'current-password'"
        />
      </label>
      @if (error()) {
        <p class="form-error" role="alert">{{ error() }}</p>
      }
      <button type="submit" class="btn primary" [disabled]="busy()">
        {{ busy() ? 'Please wait…' : registering() ? 'Create account' : 'Sign in' }}
      </button>
      @if (google()) {
        <a class="btn" href="/api/auth/google/start">Continue with Google</a>
      } @else {
        <button type="button" class="btn" disabled>Continue with Google</button>
        <small class="muted">Google sign-in is not set up on this server.</small>
      }
      <button type="button" class="btn link" (click)="toggle()">
        {{ registering() ? 'I already have an account' : 'Create a new account' }}
      </button>
    </form>
  `,
})
export class Login {
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  protected readonly registering = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly google = signal(false);

  constructor() {
    inject(Api)
      .get<{ configured: boolean }>('/auth/google/status')
      .then((status) => this.google.set(status.configured))
      .catch(() => undefined);
  }

  protected toggle(): void {
    this.registering.update((v) => !v);
    this.error.set('');
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const data = new FormData(event.target as HTMLFormElement);
    const value = (key: string) => String(data.get(key) ?? '');
    this.busy.set(true);
    this.error.set('');
    try {
      if (this.registering())
        await this.auth.register(value('username').trim(), value('name').trim(), value('password'));
      else await this.auth.login(value('username').trim(), value('password'));
      await this.router.navigateByUrl('/workspaces');
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
