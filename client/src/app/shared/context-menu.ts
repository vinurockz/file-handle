import {
  afterNextRender,
  Component,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { Menu, MenuItem } from '../core/ui';
import { clamp } from '../core/util';

@Component({
  selector: 'app-context-menu',
  template: `
    <div
      class="backdrop"
      (pointerdown)="closed.emit()"
      (contextmenu)="$event.preventDefault(); closed.emit()"
    ></div>
    <div
      class="menu"
      role="menu"
      [style.left.px]="place().x"
      [style.top.px]="place().y"
      (keydown)="keys($event)"
    >
      @for (item of menu().items; track item.label) {
        <button type="button" role="menuitem" [class.danger]="item.danger" (click)="choose(item)">
          {{ item.label }}
        </button>
      }
      @if (menu().swatches; as swatches) {
        <small>{{ swatches.label }}</small>
        <div class="row wrap" role="group" [attr.aria-label]="swatches.label">
          @for (color of swatches.colors; track color) {
            <button
              type="button"
              class="swatch"
              [style.background]="color || 'transparent'"
              [attr.aria-label]="color ? 'Colour ' + color : 'No colour'"
              [attr.aria-pressed]="swatches.current === color"
              (click)="swatches.pick(color); closed.emit()"
            ></button>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 150;
    }
    .menu {
      position: fixed;
      z-index: 151;
      width: 220px;
      max-height: calc(100vh - 16px);
      overflow: auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: var(--shadow);
      padding: 6px;
      display: flex;
      flex-direction: column;
    }
    button[role='menuitem'] {
      font: inherit;
      text-align: left;
      background: none;
      border: 0;
      border-radius: 6px;
      padding: 0.45rem 0.6rem;
      cursor: pointer;
    }
    button[role='menuitem']:hover,
    button[role='menuitem']:focus-visible {
      background: var(--surface-2);
    }
    .danger {
      color: var(--danger);
    }
    small {
      padding: 0.4rem 0.6rem 0.2rem;
      color: var(--muted);
    }
    .row {
      padding: 0 0.6rem 0.3rem;
    }
  `,
})
export class ContextMenu {
  readonly menu = input.required<Menu>();
  readonly closed = output<void>();
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly place = signal({ x: -1000, y: -1000 });

  constructor() {
    afterNextRender(() => {
      const box = this.element.nativeElement.querySelector<HTMLElement>('.menu')!;
      // Keep the whole menu on screen.
      this.place.set({
        x: clamp(this.menu().x, 8, Math.max(8, window.innerWidth - box.offsetWidth - 8)),
        y: clamp(this.menu().y, 8, Math.max(8, window.innerHeight - box.offsetHeight - 8)),
      });
      box.querySelector<HTMLElement>('button')?.focus();
    });
  }

  protected choose(item: MenuItem): void {
    this.closed.emit();
    item.run();
  }

  protected keys(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      this.closed.emit();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...this.element.nativeElement.querySelectorAll<HTMLElement>('button')];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const next = at + (event.key === 'ArrowDown' ? 1 : -1);
    buttons[(next + buttons.length) % buttons.length]?.focus();
  }
}
