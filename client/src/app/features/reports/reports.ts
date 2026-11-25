import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { Api } from '../../core/api';
import { Ui } from '../../core/ui';
import { downloadBlob, formatBytes } from '../../core/util';

interface Group {
  label: string;
  count: number;
  bytes: number;
}

interface Summary {
  generatedAt: number;
  storage: {
    totalCount: number;
    totalBytes: number;
    byType: Group[];
    byFolder: Group[];
    largest: { id: string; title: string; kind: string; size: number }[];
  };
  chats: {
    id: string;
    name: string;
    type: string;
    messages: number;
    members: number;
    attachments: number;
  }[];
  modules: { label: string; stats: Record<string, number> }[];
}

export function toCsv(rows: (string | number)[][]): string {
  const cell = (value: string | number) => {
    let text = String(value);
    // Stop spreadsheet programs treating user text as a formula.
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\r\n');
}

@Component({
  selector: 'app-reports',
  host: { class: 'page' },
  template: `
    <header class="page-head">
      <h1>Reports</h1>
      <button type="button" class="btn" (click)="load()">Refresh</button>
      <button type="button" class="btn primary" [disabled]="!data()" (click)="exportCsv()">
        Export CSV
      </button>
    </header>
    @if (data(); as report) {
      <p class="muted">Calculated {{ time(report.generatedAt) }}</p>
      <h2>Storage</h2>
      <div class="stats">
        <div class="card stat">
          <span class="muted">Files</span><strong>{{ report.storage.totalCount }}</strong>
        </div>
        <div class="card stat">
          <span class="muted">Total size</span
          ><strong>{{ bytes(report.storage.totalBytes) }}</strong>
        </div>
        @for (type of report.storage.byType; track type.label) {
          <div class="card stat">
            <span class="muted">{{ type.label }}</span><strong>{{ type.count }}</strong
            ><small>{{ bytes(type.bytes) }}</small>
          </div>
        }
      </div>
      @if (report.storage.byFolder.length) {
        <h3>By folder</h3>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Folder</th>
                <th>Files</th>
                <th>Size</th>
                <th class="bar-col">Share</th>
              </tr>
            </thead>
            <tbody>
              @for (row of report.storage.byFolder; track $index) {
                <tr>
                  <td>{{ row.label }}</td>
                  <td>{{ row.count }}</td>
                  <td>{{ bytes(row.bytes) }}</td>
                  <td>
                    <div
                      class="bar"
                      [style.width.%]="(row.bytes / (report.storage.totalBytes || 1)) * 100"
                    ></div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <h3>Largest files</h3>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              @for (file of report.storage.largest; track file.id) {
                <tr>
                  <td>{{ file.title }}</td>
                  <td>{{ file.kind }}</td>
                  <td>{{ bytes(file.size) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
      <h2>Modules</h2>
      <div class="stats">
        @for (module of moduleRows(); track module.label) {
          <div class="card">
            <h3>{{ module.label }}</h3>
            @for (stat of module.stats; track stat[0]) {
              <div class="row">
                <span class="grow muted">{{ stat[0] }}</span><strong>{{ stat[1] }}</strong>
              </div>
            }
          </div>
        }
      </div>
      <h2>Your chats</h2>
      @if (report.chats.length) {
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Conversation</th>
                <th>Type</th>
                <th>Members</th>
                <th>Messages</th>
                <th>Attachments</th>
              </tr>
            </thead>
            <tbody>
              @for (chat of report.chats; track chat.id) {
                <tr>
                  <td>{{ chat.name }}</td>
                  <td>{{ chat.type }}</td>
                  <td>{{ chat.members }}</td>
                  <td>{{ chat.messages }}</td>
                  <td>{{ chat.attachments }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <p class="muted">No chats yet.</p>
      }
    } @else if (loading()) {
      <p class="empty">Calculating…</p>
    }
  `,
  styles: `
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
      gap: 0.7rem;
      margin-bottom: 1rem;
    }
    .stat {
      display: flex;
      flex-direction: column;
    }
    .stat strong {
      font-size: 1.6rem;
    }
    .bar-col {
      width: 30%;
    }
    .bar {
      height: 10px;
      border-radius: 4px;
      background: var(--accent);
      min-width: 2px;
    }
  `,
})
export class Reports implements OnInit {
  private readonly api = inject(Api);
  private readonly ui = inject(Ui);
  protected readonly data = signal<Summary | null>(null);
  protected readonly loading = signal(false);
  protected readonly bytes = formatBytes;
  protected readonly time = (value: number) => new Date(value).toLocaleString();
  protected readonly moduleRows = computed(() =>
    (this.data()?.modules ?? []).map((m) => ({ label: m.label, stats: Object.entries(m.stats) })),
  );

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.data.set(await this.api.get<Summary>('/reports/summary'));
    } catch (error) {
      this.ui.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  protected exportCsv(): void {
    const report = this.data()!;
    const rows: (string | number)[][] = [['Section', 'Item', 'Count', 'Bytes']];
    for (const g of report.storage.byType) rows.push(['Files by type', g.label, g.count, g.bytes]);
    for (const g of report.storage.byFolder)
      rows.push(['Files by folder', g.label, g.count, g.bytes]);
    for (const m of report.modules) {
      for (const [name, count] of Object.entries(m.stats)) rows.push([m.label, name, count, '']);
    }
    for (const c of report.chats) rows.push(['Chat messages', c.name, c.messages, '']);
    downloadBlob(
      new Blob(['﻿', toCsv(rows)], { type: 'text/csv;charset=utf-8' }),
      'studio-report.csv',
    );
  }
}
