import { Component, computed, input, output } from '@angular/core';
import { arrowHead, displaySize, markLine, rectToDisplay, toDisplay } from './geometry';
import type { Annotation, PageRef, Point, Rect, Rotation } from './model';
import { totalRotation } from './model';

interface Shape {
  mark: Annotation;
  rects: Rect[];
  paths: string[];
  box: { x: number; y: number; w: number; h: number; angle: number } | null;
  bounds: Rect;
}

/** Draws a page's annotations as SVG in displayed PDF points, so it scales with the page. */
@Component({
  selector: 'app-annotation-layer',
  template: `
    <svg [attr.viewBox]="'0 0 ' + size().width + ' ' + size().height" preserveAspectRatio="none">
      @for (shape of shapes(); track shape.mark.id) {
        @let mark = shape.mark;
        <g
          class="mark"
          [class.pickable]="pickable()"
          [attr.data-type]="mark.type"
          [attr.tabindex]="pickable() ? 0 : null"
          [attr.aria-label]="pickable() ? mark.type + ' annotation' : null"
          (focus)="picked.emit(mark.id)"
          (pointerdown)="down($event, mark)"
        >
          @switch (mark.type) {
            @case ('highlight') {
              @for (r of shape.rects; track $index) {
                <svg:rect
                  [attr.x]="r.x"
                  [attr.y]="r.y"
                  [attr.width]="r.w"
                  [attr.height]="r.h"
                  [attr.fill]="mark.color"
                  opacity="0.45"
                  style="mix-blend-mode: multiply"
                />
              }
            }
            @case ('rect') {
              @for (r of shape.rects; track $index) {
                <svg:rect
                  [attr.x]="r.x"
                  [attr.y]="r.y"
                  [attr.width]="r.w"
                  [attr.height]="r.h"
                  [attr.stroke]="mark.color"
                  [attr.stroke-width]="mark.width"
                  [attr.fill]="mark.fill || 'transparent'"
                />
              }
            }
            @case ('ellipse') {
              @for (r of shape.rects; track $index) {
                <svg:ellipse
                  [attr.cx]="r.x + r.w / 2"
                  [attr.cy]="r.y + r.h / 2"
                  [attr.rx]="r.w / 2"
                  [attr.ry]="r.h / 2"
                  [attr.stroke]="mark.color"
                  [attr.stroke-width]="mark.width"
                  [attr.fill]="mark.fill || 'transparent'"
                />
              }
            }
            @case ('whiteout') {
              @for (r of shape.rects; track $index) {
                <svg:rect
                  [attr.x]="r.x"
                  [attr.y]="r.y"
                  [attr.width]="r.w"
                  [attr.height]="r.h"
                  [attr.fill]="mark.color"
                />
              }
            }
            @case ('redact') {
              @for (r of shape.rects; track $index) {
                <svg:rect
                  [attr.x]="r.x"
                  [attr.y]="r.y"
                  [attr.width]="r.w"
                  [attr.height]="r.h"
                  fill="#000"
                />
              }
            }
            @case ('ink') {
              <svg:path
                [attr.d]="shape.paths[0]"
                fill="none"
                [attr.stroke]="mark.color"
                [attr.stroke-width]="mark.width"
                [attr.opacity]="mark.opacity"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            }
            @case ('line') {
              <svg:path
                [attr.d]="shape.paths[0]"
                fill="none"
                [attr.stroke]="mark.color"
                [attr.stroke-width]="mark.width"
                stroke-linecap="round"
              />
            }
            @case ('arrow') {
              <svg:path
                [attr.d]="shape.paths.join(' ')"
                fill="none"
                [attr.stroke]="mark.color"
                [attr.stroke-width]="mark.width"
                stroke-linecap="round"
              />
            }
            @case ('underline') {
              <svg:path
                [attr.d]="shape.paths.join(' ')"
                fill="none"
                [attr.stroke]="mark.color"
                stroke-width="1.2"
              />
            }
            @case ('strike') {
              <svg:path
                [attr.d]="shape.paths.join(' ')"
                fill="none"
                [attr.stroke]="mark.color"
                stroke-width="1.2"
              />
            }
            @case ('comment') {
              <svg:text [attr.x]="shape.bounds.x" [attr.y]="shape.bounds.y + 17" font-size="19">
                💬
                <svg:title>{{ mark.text }}</svg:title>
              </svg:text>
            }
            @default {
              @if (shape.box; as box) {
                <svg:g
                  [attr.transform]="
                    'translate(' +
                    box.x +
                    ' ' +
                    box.y +
                    ') rotate(' +
                    box.angle +
                    ') translate(' +
                    -box.w / 2 +
                    ' ' +
                    -box.h / 2 +
                    ')'
                  "
                >
                  @if (mark.type === 'image') {
                    <svg:image
                      [attr.href]="mark.src"
                      [attr.width]="box.w"
                      [attr.height]="box.h"
                      preserveAspectRatio="none"
                    />
                  } @else if (mark.type === 'stamp') {
                    <svg:rect
                      [attr.width]="box.w"
                      [attr.height]="box.h"
                      fill="transparent"
                      [attr.stroke]="mark.color"
                      stroke-width="2.5"
                    />
                    <svg:text
                      [attr.x]="box.w / 2"
                      [attr.y]="box.h / 2"
                      text-anchor="middle"
                      dominant-baseline="central"
                      font-family="Helvetica, Arial, sans-serif"
                      font-weight="700"
                      [attr.font-size]="stampSize(mark.text, box.w, box.h)"
                      [attr.fill]="mark.color"
                    >
                      {{ mark.text }}
                    </svg:text>
                  } @else if (mark.type === 'text') {
                    <svg:rect [attr.width]="box.w" [attr.height]="box.h" fill="transparent" />
                    @for (line of mark.text.split('\\n'); track $index; let i = $index) {
                      <svg:text
                        x="2"
                        [attr.y]="mark.size * (1.2 * i + 0.95)"
                        font-family="Helvetica, Arial, sans-serif"
                        [attr.font-weight]="mark.bold ? 700 : 400"
                        [attr.font-size]="mark.size"
                        [attr.fill]="mark.color"
                        xml:space="preserve"
                      >
                        {{ line }}
                      </svg:text>
                    }
                  }
                </svg:g>
              }
            }
          }
          @if (selectedId() === mark.id) {
            <svg:rect
              class="selection"
              [attr.x]="shape.bounds.x - 3"
              [attr.y]="shape.bounds.y - 3"
              [attr.width]="shape.bounds.w + 6"
              [attr.height]="shape.bounds.h + 6"
            />
          }
        </g>
      }
    </svg>
  `,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 2;
    }
    svg {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    .mark.pickable {
      pointer-events: visiblePainted;
      cursor: move;
    }
    .selection {
      fill: none;
      stroke: #4f46e5;
      stroke-width: 1.5;
      stroke-dasharray: 5 3;
      pointer-events: none;
    }
  `,
})
export class AnnotationLayer {
  readonly page = input.required<PageRef>();
  readonly marks = input.required<Annotation[]>();
  readonly selectedId = input<string | null>(null);
  readonly pickable = input(false);
  readonly picked = output<string>();
  readonly grabbed = output<{ event: PointerEvent; mark: Annotation }>();
  protected readonly size = computed(() => {
    const page = this.page();
    return displaySize(page.width, page.height, totalRotation(page));
  });
  protected readonly shapes = computed(() =>
    this.marks().map((mark) => this.shape(mark, totalRotation(this.page()))),
  );

  private shape(mark: Annotation, rotation: Rotation): Shape {
    const { width, height } = this.size();
    const point = (p: Point): Point => {
      const shown = toDisplay(p, rotation);
      return { x: shown.x * width, y: shown.y * height };
    };
    const rect = (r: Rect): Rect => {
      const shown = rectToDisplay(r, rotation);
      return { x: shown.x * width, y: shown.y * height, w: shown.w * width, h: shown.h * height };
    };
    const path = (points: Point[]) =>
      points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
    const around = (points: Point[]): Rect => {
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    };
    const result: Shape = {
      mark,
      rects: [],
      paths: [],
      box: null,
      bounds: { x: 0, y: 0, w: 0, h: 0 },
    };
    switch (mark.type) {
      case 'highlight':
      case 'underline':
      case 'strike':
        result.rects = mark.rects.map(rect);
        if (mark.type !== 'highlight') {
          result.paths = mark.rects.map((r) =>
            path(markLine(r, mark.rot, mark.type as 'underline' | 'strike').map(point)),
          );
        }
        result.bounds = around(result.rects.flatMap((r) => [r, { x: r.x + r.w, y: r.y + r.h }]));
        break;
      case 'ink': {
        const points = mark.points.map(point);
        result.paths = [path(points.length === 1 ? [points[0]!, points[0]!] : points)];
        result.bounds = around(points);
        break;
      }
      case 'line':
      case 'arrow': {
        const from = point(mark.from);
        const to = point(mark.to);
        result.paths = [path([from, to])];
        if (mark.type === 'arrow') {
          const [left, right] = arrowHead(from, to, Math.max(8, mark.width * 4));
          result.paths.push(path([left, to, right]));
        }
        result.bounds = around([from, to]);
        break;
      }
      case 'rect':
      case 'ellipse':
      case 'whiteout':
      case 'redact':
        result.rects = [rect(mark.box)];
        result.bounds = result.rects[0]!;
        break;
      case 'comment': {
        const at = point(mark.at);
        result.bounds = { x: at.x, y: at.y, w: 22, h: 22 };
        break;
      }
      default: {
        const center = point(mark.center);
        const angle = rotation - mark.rot;
        result.box = { ...center, w: mark.w, h: mark.h, angle };
        const flipped = Math.abs(angle) % 180 === 90;
        const w = flipped ? mark.h : mark.w;
        const h = flipped ? mark.w : mark.h;
        result.bounds = { x: center.x - w / 2, y: center.y - h / 2, w, h };
      }
    }
    return result;
  }

  protected stampSize(text: string, w: number, h: number): number {
    return Math.min(h * 0.55, (w - 10) / Math.max(1, text.length * 0.68));
  }

  protected down(event: PointerEvent, mark: Annotation): void {
    if (!this.pickable() || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    this.picked.emit(mark.id);
    this.grabbed.emit({ event, mark });
  }
}
