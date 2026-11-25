import { Component, inject, input, output } from '@angular/core';
import { MediaLibrary } from '../../core/media';
import { Ui } from '../../core/ui';
import { clamp, moveItem, pickFiles } from '../../core/util';
import { isWebAddress } from './blocks';
import { RichText } from '../../shared/rich-text';
import type { Field, Props } from './types';

export interface PageLink {
  slug: string;
  title: string;
}

/** Renders the settings form for any block from its field list. */
@Component({
  selector: 'app-field-editor',
  imports: [RichText, FieldEditor],
  template: `
    @for (field of fields(); track field.key) {
      @switch (field.type) {
        @case ('code') {
          <label class="field"
            >{{ field.label
            }}<textarea
              rows="5"
              spellcheck="false"
              [value]="text(field.key)"
              (input)="set(field.key, $any($event.target).value)"
            ></textarea>
          </label>
          <button type="button" class="btn small" (click)="loadFile(field.key, field.label)">
            Load {{ field.label }} from file
          </button>
        }
        @case ('textarea') {
          <label class="field"
            >{{ field.label
            }}<textarea
              rows="3"
              [value]="text(field.key)"
              (input)="set(field.key, $any($event.target).value)"
            ></textarea>
          </label>
        }
        @case ('rich') {
          <div class="field">
            {{ field.label
            }}<app-rich-text
              [html]="text(field.key)"
              [label]="field.label"
              (changed)="set(field.key, $event)"
            />
          </div>
        }
        @case ('checkbox') {
          <label class="check"
            ><input
              type="checkbox"
              [checked]="!!value()[field.key]"
              (change)="set(field.key, $any($event.target).checked)"
            />
            {{ field.label }}</label
          >
        }
        @case ('color') {
          <label class="field"
            >{{ field.label
            }}<input
              type="color"
              [value]="text(field.key) || '#000000'"
              (input)="set(field.key, $any($event.target).value)"
          /></label>
        }
        @case ('number') {
          <label class="field"
            >{{ field.label }} {{ asNumber(field).unit }}
            <input
              type="number"
              [min]="asNumber(field).min"
              [max]="asNumber(field).max"
              [value]="text(field.key)"
              (change)="number(asNumber(field), $any($event.target))"
            />
          </label>
        }
        @case ('select') {
          <label class="field"
            >{{ field.label }}
            <select (change)="set(field.key, $any($event.target).value)">
              @for (option of asSelect(field).options; track option[0]) {
                <option [value]="option[0]" [selected]="text(field.key) === option[0]">
                  {{ option[1] }}
                </option>
              }
            </select>
          </label>
        }
        @case ('datetime') {
          <label class="field"
            >{{ field.label
            }}<input
              type="datetime-local"
              [value]="text(field.key)"
              (change)="set(field.key, $any($event.target).value)"
          /></label>
        }
        @case ('link') {
          <label class="field"
            >{{ field.label }}
            <input
              placeholder="https://… or choose a page below"
              [value]="text(field.key)"
              (input)="set(field.key, $any($event.target).value)"
            />
            <select
              [attr.aria-label]="field.label + ': link to a page'"
              (change)="pageChosen(field.key, $any($event.target))"
            >
              <option value="">Link to a page…</option>
              @for (page of pages(); track page.slug) {
                <option [value]="page.slug">{{ page.title }}</option>
              }
            </select>
          </label>
        }
        @case ('media') {
          <div class="field">
            {{ field.label }}
            <div class="row wrap">
              <span class="grow truncate">{{
                text(field.key) ? mediaName(text(field.key)) : 'Nothing chosen'
              }}</span>
              <button
                type="button"
                class="btn small"
                (click)="media(field.key, asMedia(field).kind)"
              >
                Choose
              </button>
              <button type="button" class="btn small" (click)="webAddress(field.key, false)">
                Web address
              </button>
              @if (text(field.key)) {
                <button type="button" class="btn small" (click)="set(field.key, '')">Remove</button>
              }
            </div>
          </div>
        }
        @case ('gallery') {
          <div class="field">
            {{ field.label }}
            @for (id of strings(field.key); track $index; let i = $index) {
              <div class="row">
                <span class="grow truncate">{{ mediaName(id) }}</span>
                <button
                  type="button"
                  class="btn ghost icon"
                  aria-label="Move up"
                  [disabled]="i === 0"
                  (click)="set(field.key, moved(strings(field.key), i, -1))"
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="btn ghost icon"
                  aria-label="Remove picture"
                  (click)="set(field.key, without(strings(field.key), i))"
                >
                  ✕
                </button>
              </div>
            }
            <button type="button" class="btn small" (click)="gallery(field.key)">
              + Add pictures
            </button>
            <button type="button" class="btn small" (click)="webAddress(field.key, true)">
              + Web address
            </button>
          </div>
        }
        @case ('list') {
          <div class="field">
            {{ field.label }}
            @for (item of items(field.key); track $index; let i = $index; let last = $last) {
              <details class="item">
                <summary>{{ asList(field).itemLabel }} {{ i + 1 }}</summary>
                <app-field-editor
                  [fields]="asList(field).fields"
                  [value]="item"
                  [pages]="pages()"
                  (changed)="item$(field.key, i, $event)"
                />
                <div class="row">
                  <button
                    type="button"
                    class="btn small"
                    [disabled]="i === 0"
                    (click)="set(field.key, moved(items(field.key), i, -1))"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    class="btn small"
                    [disabled]="last"
                    (click)="set(field.key, moved(items(field.key), i, 1))"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    class="btn small danger"
                    (click)="set(field.key, without(items(field.key), i))"
                  >
                    Remove
                  </button>
                </div>
              </details>
            }
            <button
              type="button"
              class="btn small"
              (click)="set(field.key, appended(items(field.key), asList(field).blank()))"
            >
              + Add {{ asList(field).itemLabel.toLowerCase() }}
            </button>
          </div>
        }
        @default {
          <label class="field"
            >{{ field.label
            }}<input [value]="text(field.key)" (input)="set(field.key, $any($event.target).value)"
          /></label>
        }
      }
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
    }
    .item {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.4rem 0.5rem;
      font-weight: 400;
    }
    .item > app-field-editor {
      margin: 0.5rem 0;
    }
  `,
})
export class FieldEditor {
  private readonly library = inject(MediaLibrary);
  private readonly ui = inject(Ui);
  readonly fields = input.required<Field[]>();
  readonly value = input.required<Props>();
  readonly pages = input<PageLink[]>([]);
  /** Emits only the changed keys. */
  readonly changed = output<Props>();

  protected readonly asNumber = (f: Field) => f as Extract<Field, { type: 'number' }>;
  protected readonly asSelect = (f: Field) => f as Extract<Field, { type: 'select' }>;
  protected readonly asMedia = (f: Field) => f as Extract<Field, { type: 'media' }>;
  protected readonly asList = (f: Field) => f as Extract<Field, { type: 'list' }>;
  protected readonly moved = <T>(list: T[], index: number, by: number) =>
    moveItem(list, index, index + by);
  protected readonly without = <T>(list: T[], index: number) => list.filter((_, i) => i !== index);
  protected readonly appended = <T>(list: T[], item: T) => [...list, item];

  protected text(key: string): string {
    return String(this.value()[key] ?? '');
  }

  protected strings(key: string): string[] {
    return (this.value()[key] as string[] | undefined) ?? [];
  }

  protected items(key: string): Props[] {
    return (this.value()[key] as Props[] | undefined) ?? [];
  }

  protected set(key: string, value: unknown): void {
    this.changed.emit({ [key]: value });
  }

  protected item$(key: string, index: number, patch: Props): void {
    this.set(
      key,
      this.items(key).map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }

  protected number(field: Extract<Field, { type: 'number' }>, element: HTMLInputElement): void {
    const parsed = Number(element.value);
    const next =
      element.value === '' || !Number.isFinite(parsed)
        ? field.min
        : clamp(parsed, field.min, field.max);
    element.value = String(next);
    this.set(field.key, next);
  }

  protected pageChosen(key: string, element: HTMLSelectElement): void {
    if (element.value) this.set(key, `page:${element.value}`);
    element.value = '';
  }

  protected async webAddress(key: string, append: boolean): Promise<void> {
    const url = (
      await this.ui.prompt('Picture or video address (https://…)', 'https://', 'Use')
    )?.trim();
    if (!url) return;
    if (!isWebAddress(url)) {
      this.ui.toast('Enter an address that starts with https://', 'error');
      return;
    }
    this.set(key, append ? [...this.strings(key), url] : url);
  }

  protected async loadFile(key: string, label: string): Promise<void> {
    const [file] = await pickFiles(
      label === 'CSS' ? '.css,text/css' : '.html,.htm,text/html',
      false,
    );
    if (!file) return;
    if (file.size > 500_000) this.ui.toast('Choose a file smaller than 500 KB', 'error');
    else this.set(key, await file.text());
  }

  protected mediaName(id: string): string {
    if (isWebAddress(id)) return id;
    return this.library.byId(id)?.title ?? 'Missing file';
  }

  protected async media(key: string, kind: 'image' | 'video'): Promise<void> {
    const [item] = await this.ui.pickMedia([kind]);
    if (item) this.set(key, item.id);
  }

  protected async gallery(key: string): Promise<void> {
    const items = await this.ui.pickMedia(['image'], true);
    if (items.length) this.set(key, [...this.strings(key), ...items.map((m) => m.id)]);
  }
}
