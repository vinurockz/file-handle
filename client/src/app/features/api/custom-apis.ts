import { Component, inject, OnInit, signal } from '@angular/core';
import { errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';
import { injectCollection, type Doc } from '../../core/collection';
import { Ui } from '../../core/ui';
import { Modal } from '../../shared/widgets';
import { prettyJson } from './request-utils';

interface Endpoint extends Doc {
  name: string;
  method: string;
  path: string;
  enabled: boolean;
  statusCode: number;
  contentType: string;
  body: string;
  delayMs: number;
}

@Component({
  selector: 'app-custom-apis',
  imports: [Modal],
  host: { class: 'page' },
  template: `
    <header class="page-head">
      <h1>Custom APIs</h1>
      <button type="button" class="btn primary" (click)="edit(null)">New endpoint</button>
    </header>
    <p class="muted">
      Each enabled endpoint is public: anyone who can reach this server and knows the URL can call
      it without signing in. Do not put secrets in a response.
    </p>
    @if (store.loaded() && !store.items().length) {
      <p class="empty">No endpoints yet.</p>
    }
    <div class="col">
      @for (endpoint of store.items(); track endpoint.id) {
        <article class="card row wrap">
          <label class="check" title="Enabled">
            <input
              type="checkbox"
              [checked]="endpoint.enabled"
              [attr.aria-label]="'Enable ' + endpoint.name"
              (change)="store.patch(endpoint.id, { enabled: $any($event.target).checked }, 0)"
            />
          </label>
          <div class="grow">
            <strong>{{ endpoint.name }}</strong> <span class="chip">{{ endpoint.method }}</span>
            <span class="chip">{{ endpoint.statusCode }}</span>
            <div class="url">{{ urlFor(endpoint) }}</div>
          </div>
          <button type="button" class="btn small" (click)="tryIt(endpoint)">Try it</button>
          <button type="button" class="btn small" (click)="copy(urlFor(endpoint))">Copy URL</button>
          <button type="button" class="btn small" (click)="edit(endpoint)">Edit</button>
          <button type="button" class="btn small danger" (click)="remove(endpoint)">Delete</button>
        </article>
      }
    </div>

    @if (trial(); as result) {
      <app-modal [heading]="'Try it: ' + result.title" [wide]="true" (closed)="trial.set(null)">
        <strong>{{ result.status }}</strong>
        <pre class="url">{{ result.body }}</pre>
      </app-modal>
    }

    @if (editing(); as target) {
      <app-modal
        [heading]="target === 'new' ? 'New endpoint' : 'Edit endpoint'"
        [wide]="true"
        (closed)="editing.set(null)"
      >
        <form class="col" (submit)="submit($event, target)">
          <label class="field"
            >Name
            <input
              name="name"
              autofocus
              required
              maxlength="200"
              [value]="value(target, 'name', '')"
          /></label>
          <div class="row wrap">
            <label class="field"
              >Method
              <select name="method">
                @for (method of methods; track method) {
                  <option [selected]="value(target, 'method', 'GET') === method">
                    {{ method }}
                  </option>
                }
              </select>
            </label>
            <label class="field grow"
              >Path
              <input
                name="path"
                required
                placeholder="users/list"
                [value]="value(target, 'path', '')"
            /></label>
            <label class="field"
              >Status
              <input
                name="statusCode"
                type="number"
                min="200"
                max="599"
                [value]="value(target, 'statusCode', 200)"
            /></label>
            <label class="field"
              >Delay (ms)
              <input
                name="delayMs"
                type="number"
                min="0"
                max="10000"
                [value]="value(target, 'delayMs', 0)"
            /></label>
            <label class="field"
              >Content type
              <select name="contentType">
                @for (type of types; track type) {
                  <option [selected]="value(target, 'contentType', 'application/json') === type">
                    {{ type }}
                  </option>
                }
              </select>
            </label>
          </div>
          <label class="field"
            >Response body
            <textarea
              #body
              name="body"
              rows="10"
              spellcheck="false"
              [value]="value(target, 'body', sample)"
            ></textarea>
          </label>
          @if (formError()) {
            <p class="form-error" role="alert">{{ formError() }}</p>
          }
          <div class="row end">
            <button type="button" class="btn" (click)="body.value = pretty(body.value)">
              Format JSON
            </button>
            <button type="submit" class="btn primary">Save endpoint</button>
          </div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .url {
      font-family: ui-monospace, Consolas, monospace;
      font-size: 0.82rem;
      overflow-wrap: anywhere;
      color: var(--muted);
    }
  `,
})
export class CustomApis implements OnInit {
  protected readonly store = injectCollection<Endpoint>('customEndpoints');
  private readonly auth = inject(Auth);
  private readonly ui = inject(Ui);
  protected readonly editing = signal<Endpoint | 'new' | null>(null);
  protected readonly formError = signal('');
  protected readonly methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  protected readonly types = ['application/json', 'text/plain', 'text/html'];
  protected readonly sample = '{\n  "ok": true\n}';
  protected readonly pretty = prettyJson;

  ngOnInit(): void {
    void this.store.load();
  }

  protected urlFor(endpoint: Endpoint): string {
    return `${location.origin}/api/mock/${this.auth.workspaceId()}/${endpoint.path}`;
  }

  protected value(
    target: Endpoint | 'new',
    key: keyof Endpoint,
    fallback: string | number,
  ): string | number {
    return target === 'new' ? fallback : (target[key] as string | number);
  }

  protected edit(endpoint: Endpoint | null): void {
    this.formError.set('');
    this.editing.set(endpoint ?? 'new');
  }

  protected async submit(event: Event, target: Endpoint | 'new'): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const text = (key: string) => String(data.get(key) ?? '');
    const values = {
      name: text('name').trim(),
      method: text('method'),
      path: text('path')
        .trim()
        .replace(/^\/+|\/+$/g, ''),
      statusCode: Number(text('statusCode')),
      delayMs: Number(text('delayMs')),
      contentType: text('contentType'),
      body: text('body').replace(/\r\n/g, '\n'),
    };
    try {
      if (target === 'new') await this.store.create(values);
      else {
        this.store.patch(target.id, values, 0);
        if (!(await this.store.flush(target.id))) {
          // Reload so a rejected change does not linger on screen.
          this.formError.set(
            'The server rejected that change. Check the path is valid and not already used.',
          );
          return;
        }
      }
      this.editing.set(null);
    } catch (error) {
      this.formError.set(errorMessage(error));
    }
  }

  protected async remove(endpoint: Endpoint): Promise<void> {
    if (!(await this.ui.confirm(`Delete “${endpoint.name}”?`))) return;
    try {
      await this.store.remove(endpoint.id);
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected readonly trial = signal<{ title: string; status: string; body: string } | null>(null);

  /** Calls the live endpoint exactly as an outside client would. */
  protected async tryIt(endpoint: Endpoint): Promise<void> {
    await this.store.flush(endpoint.id);
    this.trial.set({ title: `${endpoint.method} ${endpoint.path}`, status: 'Calling…', body: '' });
    try {
      const response = await fetch(this.urlFor(endpoint), {
        method: endpoint.method,
        credentials: 'omit',
      });
      const body = await response.text();
      this.trial.update(
        (t) =>
          t && {
            ...t,
            status: `${response.status} ${response.statusText}`,
            body: prettyJson(body),
          },
      );
    } catch (error) {
      this.trial.update((t) => t && { ...t, status: 'The call failed', body: errorMessage(error) });
    }
  }

  protected async copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.ui.success('URL copied');
    } catch {
      this.ui.toast('The browser did not allow copying', 'error');
    }
  }
}
