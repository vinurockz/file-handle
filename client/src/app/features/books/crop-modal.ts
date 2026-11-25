import { Component, ElementRef, input, linkedSignal, output, viewChild } from '@angular/core';
import { clamp, trackPointer } from '../../core/util';
import { Modal } from '../../shared/widgets';

export interface CropArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Moves or resizes a crop box (fractions of the picture), keeping it inside the picture. */
export function dragCrop(
  start: CropArea,
  dx: number,
  dy: number,
  mode: 'move' | 'resize',
): CropArea {
  if (mode === 'move')
    return {
      ...start,
      x: clamp(start.x + dx, 0, 1 - start.w),
      y: clamp(start.y + dy, 0, 1 - start.h),
    };
  return {
    ...start,
    w: clamp(start.w + dx, 0.05, 1 - start.x),
    h: clamp(start.h + dy, 0.05, 1 - start.y),
  };
}

@Component({
  selector: 'app-crop-modal',
  imports: [Modal],
  template: `
    <app-modal heading="Crop image" [wide]="true" (closed)="done.emit(undefined)">
      <div class="stage-wrap">
        <div #frame class="frame">
          <img [src]="src()" alt="Picture being cropped" draggable="false" />
          <div
            class="area"
            [style.left.%]="area().x * 100"
            [style.top.%]="area().y * 100"
            [style.width.%]="area().w * 100"
            [style.height.%]="area().h * 100"
            (pointerdown)="drag($event, 'move')"
          >
            <span class="grip" aria-hidden="true" (pointerdown)="drag($event, 'resize')"></span>
          </div>
        </div>
      </div>
      <p class="muted">Drag the box to move it, or its corner dot to resize it.</p>
      <div class="row end">
        <button type="button" class="btn" (click)="done.emit(undefined)">Cancel</button>
        <button type="button" class="btn primary" (click)="done.emit(area())">Apply crop</button>
      </div>
    </app-modal>
  `,
  styles: `
    .stage-wrap {
      display: grid;
      place-items: center;
    }
    .frame {
      position: relative;
      display: inline-block;
      overflow: hidden;
      user-select: none;
    }
    .frame img {
      display: block;
      max-width: 100%;
      max-height: 60vh;
    }
    .area {
      position: absolute;
      border: 2px solid #fff;
      box-shadow: 0 0 0 2000px rgb(0 0 0 / 50%);
      cursor: move;
      touch-action: none;
    }
    .grip {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--accent);
      border: 2px solid #fff;
      cursor: nwse-resize;
    }
  `,
})
export class CropModal {
  readonly src = input.required<string>();
  readonly initial = input<CropArea | null>(null);
  /** The chosen area, or undefined when cancelled. */
  readonly done = output<CropArea | undefined>();
  protected readonly area = linkedSignal<CropArea>(
    () => this.initial() ?? { x: 0, y: 0, w: 1, h: 1 },
  );
  private readonly frame = viewChild.required<ElementRef<HTMLElement>>('frame');

  protected drag(event: PointerEvent, mode: 'move' | 'resize'): void {
    event.preventDefault();
    event.stopPropagation();
    const box = this.frame().nativeElement.getBoundingClientRect();
    const start = this.area();
    trackPointer(event, ({ dx, dy }) =>
      this.area.set(dragCrop(start, dx / box.width, dy / box.height, mode)),
    );
  }
}
