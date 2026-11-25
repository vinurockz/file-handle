export interface BillItem {
  id: string;
  text: string;
  amount: string;
  fullWidth: boolean;
  align: 'left' | 'center' | 'right';
  indent: number;
  amountAlign: 'left' | 'center' | 'right';
}

/** Reads "1,250.50", "₹ 900" or "1,250/-". Returns null for anything that is not clearly a number. */
export function parseAmount(raw: string): number | null {
  const cleaned = raw
    .replace(/\/-\s*$/, '')
    .replace(/^\s*(rs\.?|inr|usd|[₹$€£])/i, '')
    .replace(/[,\s]/g, '');
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return null;
  return Number(cleaned);
}

const cents = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function totals(items: BillItem[], taxPercent: number, discount: number) {
  const amounts = items
    .filter((i) => !i.fullWidth)
    .map((i) => parseAmount(i.amount))
    .filter((n) => n !== null);
  const subtotal = cents(amounts.reduce((sum, n) => sum + n, 0));
  const off = cents(Math.min(Math.max(discount, 0), Math.max(subtotal, 0)));
  const tax = cents(((subtotal - off) * taxPercent) / 100);
  return {
    count: amounts.length,
    subtotal,
    discount: off,
    tax,
    total: cents(subtotal - off + tax),
  };
}

export const money = (value: number, currency: string): string =>
  `${currency} ${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();

export function nextBillNumber(existing: string[]): string {
  const highest = Math.max(0, ...existing.map((n) => Number(/(\d+)\s*$/.exec(n)?.[1] ?? 0)));
  return String(highest + 1);
}
