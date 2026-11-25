import { afterNextRender, Component, ElementRef, input, output, viewChild } from '@angular/core';
import { clamp } from '../core/util';

/** A slider paired with a number box showing its unit, used for every numeric setting. */
@Component({
  selector: 'app-slider',
  template: `
    <label class="slider">
      <span class="slider-label">{{ label() }}</span>
      <input
        type="range"
        [min]="min()"
        [max]="max()"
        [step]="step()"
        [value]="value()"
        (input)="emit($event)"
      />
      <span class="slider-number">
        <input
          type="number"
          [attr.aria-label]="label() + ' value'"
          [min]="min()"
          [max]="max()"
          [step]="step()"
          [value]="value()"
          (change)="emit($event)"
        />
        <small>{{ unit() }}</small>
      </span>
    </label>
  `,
})
export class Slider {
  readonly label = input.required<string>();
  readonly value = input.required<number>();
  readonly min = input(0);
  readonly max = input(100);
  readonly step = input(1);
  readonly unit = input('');
  readonly changed = output<number>();

  protected emit(event: Event): void {
    const field = event.target as HTMLInputElement;
    const next = Number(field.value);
    if (field.value === '' || !Number.isFinite(next)) {
      field.value = String(this.value());
      return;
    }
    const bounded = clamp(next, this.min(), this.max());
    if (bounded !== next) field.value = String(bounded);
    this.changed.emit(bounded);
  }
}

@Component({
  selector: 'app-modal',
  template: `
    <div class="modal-backdrop" (pointerdown)="backdrop($event)">
      <div
        #panel
        class="modal-panel"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        [attr.aria-label]="heading()"
        [class.wide]="wide()"
        (keydown)="keys($event)"
      >
        <header class="modal-head">
          <h2>{{ heading() }}</h2>
          <button type="button" class="btn ghost icon" aria-label="Close" (click)="closed.emit()">
            ✕
          </button>
        </header>
        <div class="modal-body"><ng-content /></div>
      </div>
    </div>
  `,
})
export class Modal {
  readonly heading = input.required<string>();
  readonly wide = input(false);
  readonly closed = output<void>();
  /** Keystrokes made inside the dialog; they do not travel further. */
  readonly keyed = output<KeyboardEvent>();
  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');

  constructor() {
    afterNextRender(() => {
      const panel = this.panel().nativeElement;
      (panel.querySelector<HTMLElement>('[autofocus]') ?? panel).focus();
    });
  }

  protected backdrop(event: PointerEvent): void {
    if (event.target === event.currentTarget) this.closed.emit();
  }

  /** Closes on Escape and keeps Tab focus inside the dialog. */
  protected keys(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.closed.emit();
      return;
    }
    // Keystrokes in a dialog must not trigger editor shortcuts behind it.
    event.stopPropagation();
    this.keyed.emit(event);
    if (event.key !== 'Tab') return;
    const focusable = [
      ...this.panel().nativeElement.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
