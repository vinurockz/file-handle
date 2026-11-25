/**
 * Builds a chat transcript PDF that looks like the chat: avatars and left/right bubbles.
 * Pages are drawn on canvas, so every language and emoji comes out as the browser shows it.
 */
import { canvasBlob } from '../../core/util';
import { wrapText } from '../image/text-layout';
import type { Message } from './chat-model';

export interface TranscriptPerson {
  name: string;
  color: string;
}

export interface TranscriptBlock {
  mine: boolean;
  name: string;
  color: string;
  lines: string[];
  time: string;
  height: number;
}

const PAGE = { width: 794, height: 1123, margin: 40 };
const LINE = 20;
const FONT = '14px system-ui, "Segoe UI Emoji", sans-serif';
const TEXT_WIDTH = 440;

export function bodyOf(message: Message): string {
  if (message.deletedAt) return 'This message was deleted';
  return [message.text, ...message.attachments.map((a) => `📎 ${a.name}`)]
    .filter(Boolean)
    .join('\n');
}

/** Splits messages into pages. A message taller than a page is continued on the next one. */
export function paginate(blocks: TranscriptBlock[], available: number): TranscriptBlock[][] {
  const pages: TranscriptBlock[][] = [[]];
  let used = 0;
  const rowsThatFit = (space: number) => Math.floor((space - 52) / LINE);
  for (const block of blocks) {
    let rest: TranscriptBlock | null = block;
    while (rest) {
      if (used + rest.height <= available) {
        pages.at(-1)!.push(rest);
        used += rest.height;
        rest = null;
      } else if (used > 0 && rest.height <= available) {
        pages.push([]);
        used = 0;
      } else {
        const fit = rowsThatFit(available - used);
        if (fit < 1) {
          pages.push([]);
          used = 0;
          continue;
        }
        const head: string[] = rest.lines.slice(0, fit);
        pages.at(-1)!.push({ ...rest, lines: head, height: head.length * LINE + 52 });
        const tail: string[] = rest.lines.slice(fit);
        rest = tail.length ? { ...rest, lines: tail, height: tail.length * LINE + 52 } : null;
        pages.push([]);
        used = 0;
      }
    }
  }
  return pages.filter((page, i) => page.length || i === 0);
}

export async function chatPdf(
  title: string,
  messages: Message[],
  people: ReadonlyMap<string, TranscriptPerson>,
  myId: string,
): Promise<Blob> {
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = FONT;
  const blocks = messages.map((message): TranscriptBlock => {
    const person = people.get(message.senderId) ?? { name: 'Former member', color: '#94a3b8' };
    const lines = wrapText(bodyOf(message), TEXT_WIDTH, (t) => measure.measureText(t).width);
    return {
      mine: message.senderId === myId,
      name: person.name,
      color: person.color,
      lines,
      time: `${new Date(message.createdAt).toLocaleString()}${message.editedAt ? ' · edited' : ''}`,
      height: lines.length * LINE + 52,
    };
  });
  const header = 56;
  const pages = paginate(blocks, PAGE.height - PAGE.margin * 2 - header);

  const { PDFDocument } = await import('pdf-lib');
  const output = await PDFDocument.create();
  const scale = 2;
  for (const [index, page] of pages.entries()) {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE.width * scale;
    canvas.height = PAGE.height * scale;
    const g = canvas.getContext('2d')!;
    g.scale(scale, scale);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, PAGE.width, PAGE.height);
    g.textBaseline = 'top';
    g.fillStyle = '#111827';
    g.font = `bold 20px system-ui, sans-serif`;
    g.fillText(title, PAGE.margin, PAGE.margin, PAGE.width - PAGE.margin * 2);
    g.font = '11px system-ui, sans-serif';
    g.fillStyle = '#64748b';
    g.fillText(`Page ${index + 1} of ${pages.length}`, PAGE.margin, PAGE.margin + 28);
    let y = PAGE.margin + header;
    if (!blocks.length) g.fillText('No messages yet.', PAGE.margin, y);
    for (const block of page) {
      g.font = FONT;
      const width = Math.max(150, ...block.lines.map((l) => g.measureText(l).width)) + 24;
      const x = block.mine ? PAGE.width - PAGE.margin - 40 - width : PAGE.margin + 40;
      const avatarX = block.mine ? PAGE.width - PAGE.margin - 15 : PAGE.margin + 15;
      g.fillStyle = block.color;
      g.beginPath();
      g.arc(avatarX, y + 15, 15, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.textAlign = 'center';
      g.fillText(block.name.charAt(0).toUpperCase(), avatarX, y + 8);
      g.textAlign = 'left';
      g.fillStyle = block.mine ? '#e5e4ff' : '#f1f5f9';
      g.beginPath();
      g.roundRect(x, y, width, block.height - 10, 12);
      g.fill();
      g.fillStyle = block.color;
      g.font = 'bold 12px system-ui, sans-serif';
      g.fillText(block.name, x + 12, y + 6);
      g.fillStyle = '#111827';
      g.font = FONT;
      block.lines.forEach((line, i) => g.fillText(line, x + 12, y + 22 + i * LINE));
      g.fillStyle = '#64748b';
      g.font = '10px system-ui, sans-serif';
      g.fillText(block.time, x + 12, y + 24 + block.lines.length * LINE);
      y += block.height;
    }
    const picture = await output.embedJpg(
      new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', 0.9)).arrayBuffer()),
    );
    output
      .addPage([595.28, 841.89])
      .drawImage(picture, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }
  return new Blob([(await output.save()) as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
}
