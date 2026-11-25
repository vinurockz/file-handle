import { Component, input, output } from '@angular/core';
import { FONTS } from '../features/image/model';
import type { Band } from './band';
import { Slider } from './widgets';

/** The full set of settings for one text strip. */
@Component({
  selector: 'app-band-panel',
  imports: [Slider],
  template: `
    @let item = band();
    <label class="check">
      <input
        type="checkbox"
        [checked]="item.enabled"
        (change)="changed.emit({ enabled: $any($event.target).checked })"
      />
      Show {{ label() }}
    </label>
    @if (item.enabled) {
      <textarea
        rows="2"
        [attr.aria-label]="label() + ' text'"
        [value]="item.text"
        (input)="changed.emit({ text: $any($event.target).value })"
      ></textarea>
      <select
        [attr.aria-label]="label() + ' font'"
        (change)="changed.emit({ fontFamily: $any($event.target).value })"
      >
        @for (font of fonts; track font.label) {
          <option [value]="font.value" [selected]="item.fontFamily === font.value">
            {{ font.label }}
          </option>
        }
      </select>
      <div class="row wrap">
        <button
          type="button"
          class="btn small"
          [attr.aria-pressed]="item.bold"
          (click)="changed.emit({ bold: !item.bold })"
        >
          <b>B</b>
        </button>
        <button
          type="button"
          class="btn small"
          [attr.aria-pressed]="item.italic"
          (click)="changed.emit({ italic: !item.italic })"
        >
          <i>I</i>
        </button>
        <button
          type="button"
          class="btn small"
          title="Capital letters"
          [attr.aria-pressed]="item.uppercase"
          (click)="changed.emit({ uppercase: !item.uppercase })"
        >
          AA
        </button>
        @for (side of aligns; track side) {
          <button
            type="button"
            class="btn small"
            [attr.aria-pressed]="item.align === side"
            (click)="changed.emit({ align: side })"
          >
            {{ side }}
          </button>
        }
      </div>
      <app-slider
        [label]="label() + ' thickness'"
        unit="px"
        [min]="16"
        [max]="600"
        [value]="item.size"
        (changed)="changed.emit({ size: $event })"
      />
      <app-slider
        [label]="label() + ' text size'"
        unit="px"
        [min]="8"
        [max]="200"
        [value]="item.fontSize"
        (changed)="changed.emit({ fontSize: $event })"
      />
      <app-slider
        [label]="label() + ' border'"
        unit="px"
        [max]="40"
        [value]="item.borderWidth"
        (changed)="changed.emit({ borderWidth: $event })"
      />
      <app-slider
        [label]="label() + ' opacity'"
        unit="%"
        [value]="round(item.opacity * 100)"
        (changed)="changed.emit({ opacity: $event / 100 })"
      />
      <div class="row wrap">
        <label class="field"
          >Fill
          <input
            type="color"
            [value]="item.background"
            (input)="changed.emit({ background: $any($event.target).value })"
        /></label>
        <label class="field"
          >Text
          <input
            type="color"
            [value]="item.color"
            (input)="changed.emit({ color: $any($event.target).value })"
        /></label>
        <label class="field"
          >Border
          <input
            type="color"
            [value]="item.borderColor"
            (input)="changed.emit({ borderColor: $any($event.target).value })"
        /></label>
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
  `,
})
export class BandPanel {
  readonly label = input.required<string>();
  readonly band = input.required<Band>();
  readonly changed = output<Partial<Band>>();
  protected readonly fonts = FONTS;
  protected readonly aligns = ['left', 'center', 'right'] as const;
  protected readonly round = Math.round;
}
