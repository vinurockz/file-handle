import { afterNextRender, Component, ElementRef, output, signal, viewChild } from '@angular/core';
import { trackPointer } from '../../core/util';
import { Modal } from '../../shared/widgets';

/** Returns the ink as a tightly cropped transparent PNG, or null when nothing was drawn. */
export function trimCanvas(
  source: HTMLCanvasElement,
): { url: string; width: number; height: number } | null {
  const { width, height } = source;
  const data = source.getContext('2d')!.getImageData(0, 0, width, height).data;
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!data[(y * width + x) * 4 + 3]) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = right - left + 1;
  canvas.height = bottom - top + 1;
  canvas
    .getContext('2d')!
    .drawImage(source, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return { url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

@Component({
  selector: 'app-signature-pad',
  imports: [Modal],
  template: `
    <app-modal heading="Draw your signature" (closed)="done.emit(null)">
      <canvas
        #pad
        width="800"
        height="300"
        aria-label="Signature drawing area"
        (pointerdown)="draw($event)"
      ></canvas>
      <label class="field"
        >Or type it
        <input placeholder="Your name" (input)="type($any($event.target).value)" />
      </label>
      <div class="row end">
        <label class="grow row"
          >Ink <input type="color" value="#10245c" (input)="ink.set($any($event.target).value)"
        /></label>
        <button type="button" class="btn" (click)="clear()">Clear</button>
        <button type="button" class="btn primary" (click)="finish()">Use signature</button>
      </div>
    </app-modal>
  `,
  styles: `
    canvas {
      width: 100%;
      border: 2px dashed var(--border);
      border-radius: 8px;
      touch-action: none;
      cursor: crosshair;
    }
  `,
})
export class SignaturePad {
  readonly done = output<{ url: string; width: number; height: number } | null>();
  protected readonly ink = signal('#10245c');
  private readonly pad = viewChild.required<ElementRef<HTMLCanvasElement>>('pad');

  constructor() {
    afterNextRender(() => this.clear());
  }

  private context(): CanvasRenderingContext2D {
    return this.pad().nativeElement.getContext('2d', { willReadFrequently: true })!;
  }

  protected clear(): void {
    this.context().clearRect(0, 0, 800, 300);
  }

  protected draw(event: PointerEvent): void {
    const canvas = this.pad().nativeElement;
    const box = canvas.getBoundingClientRect();
    const at = (e: PointerEvent) =>
      [
        ((e.clientX - box.left) / box.width) * 800,
        ((e.clientY - box.top) / box.height) * 300,
      ] as const;
    const context = this.context();
    context.strokeStyle = this.ink();
    context.lineWidth = 5;
    context.lineCap = context.lineJoin = 'round';
    let [x, y] = at(event);
    trackPointer(event, ({ event: move }) => {
      const [nx, ny] = at(move);
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(nx, ny);
      context.stroke();
      [x, y] = [nx, ny];
    });
  }

  protected type(text: string): void {
    this.clear();
    const context = this.context();
    context.fillStyle = this.ink();
    context.font = 'italic 96px "Segoe Script", "Brush Script MT", cursive';
    context.textBaseline = 'middle';
    context.fillText(text, 24, 150, 752);
  }

  protected finish(): void {
    this.done.emit(trimCanvas(this.pad().nativeElement));
  }
}
