import { Component, input, output } from '@angular/core';
import { mediaUrl } from '../../core/media';

/** Page coordinates are fractions of the page box; font sizes assume a 600px-wide page. */
export interface BookElement {
  id: string;
  type: 'text' | 'image' | 'shape';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  text: string;
  fontSize: number;
  fontFamily: 'sans' | 'serif' | 'mono';
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  mediaId: string | null;
  crop: { x: number; y: number; w: number; h: number } | null;
  shape: 'rectangle' | 'ellipse' | 'line';
  fill: string;
}

export interface Page {
  background: string;
  elements: BookElement[];
}

export const FONTS = {
  sans: 'system-ui, sans-serif',
  serif: 'Georgia, serif',
  mono: 'ui-monospace, monospace',
};

/** The one renderer for a page, shared by the editor, the reader and printing so they cannot disagree. */
@Component({
  selector: 'app-page-view',
  template: `
    <div class="sheet" [style.background]="page().background" (pointerdown)="blank($event)">
      @for (element of page().elements; track element.id) {
        <div
          class="element"
          [class.selected]="selectedId() === element.id"
          [class.interactive]="interactive()"
          [style.left.%]="element.x * 100"
          [style.top.%]="element.y * 100"
          [style.width.%]="element.width * 100"
          [style.height.%]="element.height * 100"
          [style.rotate]="element.rotation + 'deg'"
          [attr.tabindex]="interactive() ? 0 : null"
          [attr.aria-label]="interactive() ? element.type + ' element' : null"
          (focus)="picked.emit(element.id)"
          (pointerdown)="down($event, element, 'move')"
        >
          @switch (element.type) {
            @case ('text') {
              <div
                class="text"
                [style.font-size]="'calc(' + element.fontSize + ' / 600 * 100cqw)'"
                [style.font-family]="fonts[element.fontFamily]"
                [style.color]="element.color"
                [style.font-weight]="element.bold ? 700 : 400"
                [style.font-style]="element.italic ? 'italic' : 'normal'"
                [style.text-align]="element.align"
              >
                {{ element.text }}
              </div>
            }
            @case ('image') {
              <div class="crop">
                <img
                  [src]="url(element.mediaId)"
                  alt=""
                  draggable="false"
                  [style.width.%]="100 / (element.crop?.w ?? 1)"
                  [style.height.%]="100 / (element.crop?.h ?? 1)"
                  [style.left.%]="(-(element.crop?.x ?? 0) / (element.crop?.w ?? 1)) * 100"
                  [style.top.%]="(-(element.crop?.y ?? 0) / (element.crop?.h ?? 1)) * 100"
                />
              </div>
            }
            @case ('shape') {
              <div [class]="'shape ' + element.shape" [style.background]="element.fill"></div>
            }
          }
          @if (interactive() && selectedId() === element.id) {
            <span
              class="handle"
              aria-hidden="true"
              (pointerdown)="down($event, element, 'resize')"
            ></span>
          }
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      container-type: inline-size;
      width: 100%;
    }
    .sheet {
      position: relative;
      aspect-ratio: 3 / 4;
      overflow: hidden;
    }
    .element {
      position: absolute;
    }
    .element.interactive {
      cursor: move;
      touch-action: none;
    }
    .element.selected {
      outline: 2px dashed #4f46e5;
    }
    .text {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.35;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    .crop {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    .crop img {
      position: absolute;
      max-width: none;
      object-fit: fill;
    }
    .shape {
      width: 100%;
      height: 100%;
    }
    .shape.ellipse {
      border-radius: 50%;
    }
    .shape.line {
      height: 3px;
      position: relative;
      top: 50%;
    }
    .handle {
      position: absolute;
      right: -8px;
      bottom: -8px;
      width: 16px;
      height: 16px;
      background: #4f46e5;
      border: 2px solid #fff;
      border-radius: 50%;
      cursor: nwse-resize;
    }
  `,
})
export class PageView {
  readonly page = input.required<Page>();
  readonly interactive = input(false);
  readonly selectedId = input<string | null>(null);
  readonly picked = output<string | null>();
  readonly gesture = output<{
    event: PointerEvent;
    element: BookElement;
    mode: 'move' | 'resize';
  }>();
  protected readonly url = mediaUrl;
  protected readonly fonts = FONTS;

  protected down(event: PointerEvent, element: BookElement, mode: 'move' | 'resize'): void {
    if (!this.interactive() || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    this.picked.emit(element.id);
    this.gesture.emit({ event, element, mode });
  }

  protected blank(event: PointerEvent): void {
    if (this.interactive() && event.target === event.currentTarget) this.picked.emit(null);
  }
}
