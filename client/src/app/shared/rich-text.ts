import { Component, effect, ElementRef, input, output, viewChild } from '@angular/core';
import DOMPurify from 'dompurify';

const CONFIG = {
  ALLOWED_TAGS: [
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'strike',
    'br',
    'div',
    'p',
    'ul',
    'ol',
    'li',
    'span',
    'font',
    'a',
  ],
  ALLOWED_ATTR: ['href', 'size', 'color', 'target', 'rel'],
};

export const cleanHtml = (html: string): string => DOMPurify.sanitize(html, CONFIG);

export function htmlToText(html: string): string {
  const spaced = html.replace(/<br\s*\/?>|<\/(div|p|li)>/gi, '$&\n');
  return (
    new DOMParser().parseFromString(cleanHtml(spaced), 'text/html').body.textContent?.trim() ?? ''
  );
}

/** A small contenteditable editor. Its HTML is sanitised on the way in and on the way out. */
@Component({
  selector: 'app-rich-text',
  template: `
    <div class="rich-tools" role="toolbar" aria-label="Text formatting">
      @for (tool of tools; track tool.command) {
        <button
          type="button"
          class="btn ghost icon"
          [title]="tool.title"
          [attr.aria-label]="tool.title"
          (mousedown)="$event.preventDefault()"
          (click)="run(tool.command, tool.value)"
        >
          {{ tool.label }}
        </button>
      }
    </div>
    <div
      #editor
      class="rich-body"
      contenteditable="true"
      role="textbox"
      aria-multiline="true"
      [attr.aria-label]="label()"
      [attr.data-placeholder]="label()"
      (input)="emit()"
      (paste)="paste($event)"
      (drop)="$event.preventDefault()"
    ></div>
  `,
})
export class RichText {
  readonly html = input.required<string>();
  readonly label = input('Write something');
  readonly changed = output<string>();
  private readonly editor = viewChild.required<ElementRef<HTMLDivElement>>('editor');
  private lastEmitted: string | null = null;

  protected readonly tools = [
    { command: 'bold', label: 'B', title: 'Bold', value: undefined },
    { command: 'italic', label: 'I', title: 'Italic', value: undefined },
    { command: 'underline', label: 'U', title: 'Underline', value: undefined },
    { command: 'strikeThrough', label: 'S', title: 'Strikethrough', value: undefined },
    { command: 'insertUnorderedList', label: '•', title: 'Bulleted list', value: undefined },
    { command: 'insertOrderedList', label: '1.', title: 'Numbered list', value: undefined },
    { command: 'fontSize', label: 'A+', title: 'Larger text', value: '5' },
    { command: 'fontSize', label: 'A++', title: 'Largest text', value: '6' },
    { command: 'fontSize', label: 'A−', title: 'Normal text', value: '3' },
    { command: 'removeFormat', label: '⌫', title: 'Clear formatting', value: undefined },
  ];

  constructor() {
    effect(() => {
      const html = this.html();
      const element = this.editor().nativeElement;
      // Rewriting our own output would move the caret, so only apply outside changes.
      if (html === this.lastEmitted) return;
      this.lastEmitted = html;
      element.innerHTML = cleanHtml(html);
    });
  }

  protected run(command: string, value?: string): void {
    this.editor().nativeElement.focus();
    // execCommand is deprecated but remains the only dependency-free rich-text editing API.
    document.execCommand(command, false, value);
    this.emit();
  }

  protected emit(): void {
    this.lastEmitted = cleanHtml(this.editor().nativeElement.innerHTML);
    this.changed.emit(this.lastEmitted);
  }

  /** Paste as plain text so foreign styles and markup never enter the document. */
  protected paste(event: ClipboardEvent): void {
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData?.getData('text/plain') ?? '');
  }
}
