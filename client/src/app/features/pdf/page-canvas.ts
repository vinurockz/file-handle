import { Component, effect, ElementRef, input, output, viewChild } from '@angular/core';
import type { PDFDocumentProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import { displaySize } from './geometry';
import { totalRotation, type PageRef } from './model';
import { pdfjs } from './pdfjs';

/** Renders one page (canvas plus an optional selectable text layer) at a given scale. */
@Component({
  selector: 'app-pdf-page',
  template: `
    <canvas #canvas></canvas>
    <div #text class="textLayer" [class.selectable]="selectable()"></div>
  `,
  host: {
    '[style.width.px]': 'cssSize().width',
    '[style.height.px]': 'cssSize().height',
    '[style.--total-scale-factor]': 'scale()',
  },
})
export class PdfPageCanvas {
  readonly page = input.required<PageRef>();
  readonly pdf = input<PDFDocumentProxy | null>(null);
  readonly scale = input(1);
  readonly withText = input(false);
  readonly selectable = input(false);
  readonly rendered = output<void>();
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly text = viewChild.required<ElementRef<HTMLDivElement>>('text');

  protected cssSize() {
    const page = this.page();
    const size = displaySize(page.width, page.height, totalRotation(page));
    return { width: size.width * this.scale(), height: size.height * this.scale() };
  }

  constructor() {
    effect((onCleanup) => {
      const page = this.page();
      const pdf = this.pdf();
      const scale = this.scale();
      const withText = this.withText();
      const canvas = this.canvas().nativeElement;
      const container = this.text().nativeElement;
      let cancelled = false;
      let task: RenderTask | null = null;
      let layer: TextLayer | null = null;
      onCleanup(() => {
        cancelled = true;
        task?.cancel();
        layer?.cancel();
      });
      container.replaceChildren();
      const size = displaySize(page.width, page.height, totalRotation(page));
      const ratio = Math.min(2, window.devicePixelRatio || 1);

      void (async () => {
        // Render off-screen so a cancelled render never leaves a half-drawn page.
        const buffer = document.createElement('canvas');
        buffer.width = Math.max(1, Math.round(size.width * scale * ratio));
        buffer.height = Math.max(1, Math.round(size.height * scale * ratio));
        const source = pdf && page.source ? await pdf.getPage(page.index + 1) : null;
        if (cancelled) return;
        if (source) {
          const viewport = source.getViewport({
            scale: scale * ratio,
            rotation: totalRotation(page),
          });
          task = source.render({ canvas: buffer, viewport });
          await task.promise;
        } else {
          const context = buffer.getContext('2d')!;
          context.fillStyle = '#fff';
          context.fillRect(0, 0, buffer.width, buffer.height);
        }
        if (cancelled) return;
        canvas.width = buffer.width;
        canvas.height = buffer.height;
        canvas.getContext('2d')!.drawImage(buffer, 0, 0);
        if (source && withText) {
          const { TextLayer: Layer } = await pdfjs();
          if (cancelled) return;
          layer = new Layer({
            textContentSource: source.streamTextContent(),
            container,
            viewport: source.getViewport({ scale, rotation: totalRotation(page) }),
          });
          await layer.render();
        }
        if (!cancelled) this.rendered.emit();
      })().catch((error: unknown) => {
        if ((error as Error)?.name !== 'RenderingCancelledException' && !cancelled)
          console.warn(error);
      });
    });
  }
}
