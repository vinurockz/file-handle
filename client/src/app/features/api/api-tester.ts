import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { Api, errorMessage } from '../../core/api';
import { injectCollection, type Doc } from '../../core/collection';
import { Ui } from '../../core/ui';
import { downloadBlob, formatBytes, uid } from '../../core/util';
import {
  base64Bytes,
  bodyKind,
  buildHeaders,
  prettyJson,
  type BodyKind,
  type HeaderRow,
} from './request-utils';

interface Draft {
  method: string;
  url: string;
  headers: HeaderRow[];
  bodyType: 'none' | 'json' | 'text';
  body: string;
}

type ApiRequest = Doc & Draft & { name: string; saved: boolean };

interface Result {
  status: number;
  statusText: string;
  headers: { key: string; value: string }[];
  timeMs: number;
  sizeBytes: number;
  truncated: boolean;
  kind: BodyKind;
  text: string;
  blob: Blob;
  objectUrl: string;
}

const HISTORY_LIMIT = 30;

@Component({
  selector: 'app-api-tester',
  host: { class: 'page' },
  template: `
    <header class="page-head"><h1>API Tester</h1></header>
    <div class="layout">
      <aside class="card col" aria-label="Saved requests and history">
        <button type="button" class="btn" (click)="newRequest()">New request</button>
        @for (group of groups(); track group.title) {
          <div class="row">
            <h3 class="grow">{{ group.title }}</h3>
            @if (group.title === 'History' && group.items.length) {
              <button type="button" class="btn small" (click)="clearHistory()">Clear</button>
            }
          </div>
          @for (item of group.items; track item.id) {
            <div class="list-item">
              <button type="button" class="pick" [title]="item.url" (click)="load(item)">
                <strong>{{ item.method }}</strong> {{ item.name || item.url }}
              </button>
              <button
                type="button"
                class="btn ghost icon"
                aria-label="Remove"
                (click)="remove(item.id)"
              >
                ✕
              </button>
            </div>
          } @empty {
            <p class="muted">Nothing yet.</p>
          }
        }
      </aside>

      <section class="col">
        <form class="row wrap" (submit)="send($event)">
          <select aria-label="Method" (change)="set({ method: $any($event.target).value })">
            @for (method of methods; track method) {
              <option [value]="method" [selected]="draft().method === method">{{ method }}</option>
            }
          </select>
          <input
            class="grow"
            aria-label="URL"
            placeholder="https://api.example.com/items"
            [value]="draft().url"
            (input)="set({ url: $any($event.target).value })"
          />
          <button type="submit" class="btn primary" [disabled]="sending() || !draft().url.trim()">
            {{ sending() ? 'Sending…' : 'Send' }}
          </button>
          <button type="button" class="btn" [disabled]="!draft().url.trim()" (click)="save()">
            Save
          </button>
        </form>

        <div class="card col">
          <h3>Headers</h3>
          @for (row of draft().headers; track row.id) {
            <div class="row">
              <input
                type="checkbox"
                aria-label="Send this header"
                [checked]="row.enabled"
                (change)="header(row.id, { enabled: $any($event.target).checked })"
              />
              <input
                class="grow"
                aria-label="Header name"
                placeholder="Name"
                [value]="row.key"
                (input)="header(row.id, { key: $any($event.target).value })"
              />
              <input
                class="grow"
                aria-label="Header value"
                placeholder="Value"
                [value]="row.value"
                (input)="header(row.id, { value: $any($event.target).value })"
              />
              <button
                type="button"
                class="btn ghost icon"
                aria-label="Remove header"
                (click)="removeHeader(row.id)"
              >
                ✕
              </button>
            </div>
          }
          <button type="button" class="btn small" (click)="addHeader()">+ Header</button>
          <div class="row">
            <h3>Body</h3>
            <select aria-label="Body type" (change)="set({ bodyType: $any($event.target).value })">
              <option value="none" [selected]="draft().bodyType === 'none'">None</option>
              <option value="json" [selected]="draft().bodyType === 'json'">JSON</option>
              <option value="text" [selected]="draft().bodyType === 'text'">Text</option>
            </select>
            @if (draft().bodyType === 'json') {
              <button type="button" class="btn small" (click)="set({ body: pretty(draft().body) })">
                Format
              </button>
            }
          </div>
          @if (draft().bodyType !== 'none') {
            <textarea
              class="mono"
              rows="7"
              aria-label="Request body"
              spellcheck="false"
              [value]="draft().body"
              (input)="set({ body: $any($event.target).value })"
            ></textarea>
            @if (jsonError()) {
              <p class="form-error">{{ jsonError() }}</p>
            }
          }
        </div>

        @if (error()) {
          <p class="form-error" role="alert">{{ error() }}</p>
        }
        @if (result(); as response) {
          <div class="card col">
            <div class="row wrap">
              <strong [class.form-error]="response.status >= 400"
                >{{ response.status }} {{ response.statusText }}</strong
              >
              <span class="muted grow"
                >{{ response.timeMs }} ms · {{ bytes(response.sizeBytes)
                }}{{ response.truncated ? ' (cut at 5 MB)' : '' }}</span
              >
              @if (response.kind === 'json' || response.kind === 'text') {
                <button type="button" class="btn small" (click)="copy(response.text)">Copy</button>
              }
              <button
                type="button"
                class="btn small"
                [disabled]="response.kind === 'empty'"
                (click)="download(response)"
              >
                Download
              </button>
            </div>
            <details>
              <summary>Response headers ({{ response.headers.length }})</summary>
              <button type="button" class="btn small" (click)="copy(headerText(response))">
                Copy headers
              </button>
              @for (item of response.headers; track $index) {
                <div class="mono">
                  <strong>{{ item.key }}:</strong> {{ item.value }}
                </div>
              }
            </details>
            @switch (response.kind) {
              @case ('image') {
                <img [src]="response.objectUrl" alt="Response" />
              }
              @case ('video') {
                <video [src]="response.objectUrl" controls></video>
              }
              @case ('audio') {
                <audio [src]="response.objectUrl" controls></audio>
              }
              @case ('empty') {
                <p class="muted">The response has no body.</p>
              }
              @case ('binary') {
                <p class="muted">Binary response. Download it to inspect.</p>
              }
              @default {
                <pre class="mono">{{ response.text }}</pre>
              }
            }
          </div>
        }
      </section>
    </div>
  `,
  styles: `
    .layout {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      gap: 1rem;
      align-items: start;
    }
    .mono {
      font-family: ui-monospace, Consolas, monospace;
      font-size: 0.85rem;
      overflow-wrap: anywhere;
    }
    pre {
      background: #11152a;
      color: #e6e9ff;
      padding: 0.8rem;
      border-radius: 8px;
      max-height: 460px;
      overflow: auto;
      white-space: pre-wrap;
    }
    @media (max-width: 800px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class ApiTester implements OnInit {
  private readonly api = inject(Api);
  private readonly ui = inject(Ui);
  protected readonly requests = injectCollection<ApiRequest>('apiRequests');
  protected readonly methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  protected readonly bytes = formatBytes;
  protected readonly pretty = prettyJson;
  protected readonly draft = signal<Draft>({
    method: 'GET',
    url: '',
    headers: [],
    bodyType: 'none',
    body: '',
  });
  protected readonly sending = signal(false);
  protected readonly result = signal<Result | null>(null);
  protected readonly error = signal('');
  protected readonly groups = computed(() => {
    const newest = [...this.requests.items()].sort((a, b) => b.createdAt - a.createdAt);
    return [
      { title: 'Saved', items: newest.filter((r) => r.saved) },
      { title: 'History', items: newest.filter((r) => !r.saved) },
    ];
  });
  protected readonly jsonError = computed(() => {
    const { bodyType, body } = this.draft();
    if (bodyType !== 'json' || !body.trim()) return '';
    try {
      JSON.parse(body);
      return '';
    } catch (error) {
      return `Not valid JSON: ${(error as Error).message}`;
    }
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.release());
  }

  ngOnInit(): void {
    void this.requests.load();
  }

  private release(): void {
    const url = this.result()?.objectUrl;
    if (url) URL.revokeObjectURL(url);
  }

  protected set(patch: Partial<Draft>): void {
    this.draft.update((d) => ({ ...d, ...patch }));
  }

  protected addHeader(): void {
    this.set({
      headers: [...this.draft().headers, { id: uid(), key: '', value: '', enabled: true }],
    });
  }

  protected header(id: string, patch: Partial<HeaderRow>): void {
    this.set({ headers: this.draft().headers.map((h) => (h.id === id ? { ...h, ...patch } : h)) });
  }

  protected removeHeader(id: string): void {
    this.set({ headers: this.draft().headers.filter((h) => h.id !== id) });
  }

  protected load({ method, url, headers, bodyType, body }: ApiRequest): void {
    this.draft.set({ method, url, headers, bodyType, body });
    this.error.set('');
  }

  protected async send(event: Event): Promise<void> {
    event.preventDefault();
    const draft = this.draft();
    if (this.sending() || !draft.url.trim()) return;
    this.sending.set(true);
    this.error.set('');
    try {
      const raw = await this.api.post<
        Omit<Result, 'kind' | 'text' | 'blob' | 'objectUrl'> & { bodyBase64: string }
      >('/api-tester/send', {
        method: draft.method,
        url: draft.url,
        headers: buildHeaders(draft.headers, draft.bodyType),
        body: draft.bodyType === 'none' ? null : draft.body,
      });
      const type = raw.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
      const data = base64Bytes(raw.bodyBase64);
      const kind = bodyKind(type, data.length);
      const text = kind === 'json' || kind === 'text' ? new TextDecoder().decode(data) : '';
      const blob = new Blob([data], { type: type.split(';')[0] });
      this.release();
      this.result.set({
        ...raw,
        kind,
        text: kind === 'json' ? prettyJson(text) : text,
        blob,
        objectUrl: ['image', 'video', 'audio'].includes(kind) ? URL.createObjectURL(blob) : '',
      });
      await this.remember(draft);
    } catch (error) {
      this.release();
      this.result.set(null);
      this.error.set(errorMessage(error));
    } finally {
      this.sending.set(false);
    }
  }

  private async remember(draft: Draft): Promise<void> {
    try {
      await this.requests.create({ ...draft, name: '', saved: false });
      for (const old of this.groups()[1]!.items.slice(HISTORY_LIMIT))
        await this.requests.remove(old.id);
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected async save(): Promise<void> {
    const name = await this.ui.prompt('Name this request', this.draft().url);
    if (!name) return;
    try {
      await this.requests.create({ ...this.draft(), name: name.slice(0, 200), saved: true });
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected newRequest(): void {
    this.draft.set({ method: 'GET', url: '', headers: [], bodyType: 'none', body: '' });
    this.error.set('');
    this.release();
    this.result.set(null);
  }

  protected async clearHistory(): Promise<void> {
    if (!(await this.ui.confirm('Clear the request history?', 'Saved requests are kept.', 'Clear')))
      return;
    for (const item of this.groups()[1]!.items) await this.remove(item.id);
  }

  protected headerText(response: Result): string {
    return response.headers.map((h) => `${h.key}: ${h.value}`).join('\n');
  }

  protected async remove(id: string): Promise<void> {
    try {
      await this.requests.remove(id);
    } catch (error) {
      this.ui.error(error);
    }
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.ui.success('Copied');
    } catch {
      this.ui.toast('The browser did not allow copying', 'error');
    }
  }

  protected download(response: Result): void {
    const extension =
      response.kind === 'json'
        ? 'json'
        : response.kind === 'text'
          ? 'txt'
          : response.blob.type.split('/')[1] || 'bin';
    downloadBlob(response.blob, `response.${extension}`);
  }
}
