/** Draws a bill onto a canvas for photo export, mirroring the on-screen preview layout. */
import { mediaUrl } from '../../core/media';
import { loadImage } from '../../core/util';
import { wrapText } from '../image/text-layout';
import type { Bill } from './bills';
import { money, totals } from './bill-math';

const WIDTH = 1240;
const MARGIN = 80;
const FONT = 'Georgia, "Times New Roman", serif';

export async function renderBill(bill: Bill): Promise<HTMLCanvasElement> {
  const optional = (id: string | null) =>
    id ? loadImage(mediaUrl(id)).catch(() => null) : Promise.resolve(null);
  const [logo, signature] = await Promise.all([
    optional(bill.companyLogoMediaId),
    optional(bill.signatureMediaId),
  ]);
  // First pass measures the height, the second pass paints at that size.
  const probe = document.createElement('canvas').getContext('2d')!;
  const height = paint(probe, bill, logo, signature, 0);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = Math.max(1754, height);
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  paint(context, bill, logo, signature, canvas.height);
  return canvas;
}

function paint(
  ctx: CanvasRenderingContext2D,
  bill: Bill,
  logo: HTMLImageElement | null,
  signature: HTMLImageElement | null,
  pageHeight: number,
): number {
  const inner = WIDTH - MARGIN * 2;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#111';

  const write = (
    text: string,
    x: number,
    y: number,
    width: number,
    size: number,
    options: { align?: CanvasTextAlign; bold?: boolean } = {},
  ): number => {
    ctx.font = `${options.bold ? 'bold ' : ''}${size}px ${FONT}`;
    ctx.textAlign = options.align ?? 'left';
    const at =
      ctx.textAlign === 'center' ? x + width / 2 : ctx.textAlign === 'right' ? x + width : x;
    for (const line of wrapText(text, width, (t) => ctx.measureText(t).width)) {
      ctx.fillText(line, at, y);
      y += size * 1.4;
    }
    return y;
  };
  const rule = (y: number) => ctx.fillRect(MARGIN, y, inner, 3);

  let leftEnd = MARGIN;
  if (logo) {
    const scale = Math.min(420 / logo.width, 150 / logo.height);
    ctx.drawImage(logo, MARGIN, MARGIN, logo.width * scale, logo.height * scale);
    leftEnd = MARGIN + logo.height * scale;
  } else {
    leftEnd = write(bill.companyName, MARGIN, MARGIN, inner * 0.55, 44, { bold: true });
    if (bill.companyTagline)
      leftEnd = write(bill.companyTagline, MARGIN, leftEnd, inner * 0.55, 24);
  }
  const rightEnd = write(
    [bill.companyAddress, bill.companyPhone].filter(Boolean).join('\n'),
    MARGIN + inner * 0.6,
    MARGIN,
    inner * 0.4,
    24,
    { align: 'right' },
  );
  let y = Math.max(leftEnd, rightEnd) + 20;
  rule(y);
  y = write(bill.docType.toUpperCase(), MARGIN, y + 30, inner, 38, { align: 'center', bold: true });
  write(bill.billNo ? `No. ${bill.billNo}` : '', MARGIN, y, inner / 2, 26);
  y =
    write(bill.date ? `Date: ${bill.date}` : ' ', MARGIN + inner / 2, y, inner / 2, 26, {
      align: 'right',
    }) + 20;
  y =
    write(
      `To,\n${[bill.recipientName, bill.recipientAddress].filter(Boolean).join('\n')}`,
      MARGIN,
      y,
      inner * 0.65,
      28,
    ) + 20;
  y = write(bill.salutation, MARGIN, y, inner, 28);
  y = write(bill.introText, MARGIN, y + 8, inner, 28) + 30;

  const textWidth = inner * 0.7;
  for (const item of bill.items) {
    const full = item.fullWidth || !item.amount;
    const indent = item.indent * 40;
    const textEnd = write(
      item.text,
      MARGIN + indent,
      y,
      (full ? inner : textWidth - 20) - indent,
      28,
      { align: item.align },
    );
    const amountEnd = full
      ? textEnd
      : write(item.amount, MARGIN + textWidth, y, inner - textWidth, 28, {
          align: item.amountAlign,
        });
    y = Math.max(textEnd, amountEnd) + 12;
  }

  const sums = totals(bill.items, bill.taxPercent, bill.discount);
  if (sums.count > 1 || sums.discount || sums.tax) {
    const rows: [string, string][] = [];
    if (sums.discount || sums.tax) rows.push(['Subtotal', money(sums.subtotal, bill.currency)]);
    if (sums.discount) rows.push(['Discount', `− ${money(sums.discount, bill.currency)}`]);
    if (sums.tax) rows.push([`Tax (${bill.taxPercent}%)`, money(sums.tax, bill.currency)]);
    rows.push(['Total', money(sums.total, bill.currency)]);
    ctx.fillRect(MARGIN + textWidth, y, inner - textWidth, 2);
    y += 14;
    for (const [label, value] of rows) {
      write(label, MARGIN, y, textWidth - 30, 28, { align: 'right', bold: label === 'Total' });
      y = write(value, MARGIN + textWidth, y, inner - textWidth, 28, {
        align: 'right',
        bold: label === 'Total',
      });
    }
    ctx.fillRect(MARGIN + textWidth, y, inner - textWidth, 2);
    y += 20;
  }

  const signX = MARGIN + inner * 0.55;
  y = write(bill.signOffText, signX, y + 50, inner * 0.45, 28, { align: 'right' });
  if (signature) {
    const scale = Math.min(280 / signature.width, 110 / signature.height);
    ctx.drawImage(
      signature,
      WIDTH - MARGIN - signature.width * scale,
      y + 8,
      signature.width * scale,
      signature.height * scale,
    );
    y += signature.height * scale + 16;
  } else {
    y += 80;
  }
  y = write(bill.signerName, signX, y, inner * 0.45, 28, { align: 'right', bold: true });

  if (bill.footerText) {
    ctx.font = `22px ${FONT}`;
    const lines = wrapText(bill.footerText, inner, (t) => ctx.measureText(t).width).length;
    const footerHeight = lines * 22 * 1.4 + 24;
    const top = pageHeight ? pageHeight - MARGIN - footerHeight : y + 40;
    rule(top);
    write(bill.footerText, MARGIN, top + 18, inner, 22, { align: 'center' });
    y += footerHeight + 40;
  }
  return Math.ceil(y + MARGIN);
}
