import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { injectCollection, type Doc } from '../../core/collection';
import { mediaUrl } from '../../core/media';
import { Ui } from '../../core/ui';
import { canvasBlob, downloadBlob, moveItem, uid } from '../../core/util';
import { today } from '../tasks/tasks';
import { renderBill } from './bill-canvas';
import { money, nextBillNumber, totals, type BillItem } from './bill-math';

export interface Bill extends Doc {
  docType: 'bill' | 'quotation';
  date: string;
  billNo: string;
  companyLogoMediaId: string | null;
  companyName: string;
  companyTagline: string;
  companyAddress: string;
  companyPhone: string;
  recipientName: string;
  recipientAddress: string;
  salutation: string;
  introText: string;
  items: BillItem[];
  currency: string;
  taxPercent: number;
  discount: number;
  signOffText: string;
  signerName: string;
  signatureMediaId: string | null;
  footerText: string;
}

type TextKey = {
  [K in keyof Bill]: Bill[K] extends string ? K : never;
}[keyof Bill];

/** Letterhead details carried from the latest bill into a new one. */
const CARRIED = [
  'companyLogoMediaId',
  'companyName',
  'companyTagline',
  'companyAddress',
  'companyPhone',
  'currency',
  'taxPercent',
  'signOffText',
  'signerName',
  'signatureMediaId',
  'footerText',
  'salutation',
  'introText',
] as const;

const newItem = (): BillItem => ({
  id: uid(),
  text: '',
  amount: '',
  fullWidth: false,
  align: 'left',
  indent: 0,
  amountAlign: 'right',
});

@Component({
  selector: 'app-bills',
  host: { class: 'page' },
  templateUrl: './bills.html',
  styles: `
    .split {
      display: grid;
      grid-template-columns: minmax(300px, 440px) minmax(0, 1fr);
      gap: 1rem;
      align-items: start;
    }
    .item {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.5rem;
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }
    .paper {
      background: #fff;
      color: #111;
      font-family: Georgia, 'Times New Roman', serif;
      padding: 6%;
      min-height: 900px;
      display: flex;
      flex-direction: column;
      gap: 0.8rem;
      box-shadow: var(--shadow);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .head,
    .meta {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
    }
    .head {
      border-bottom: 2px solid #111;
      padding-bottom: 0.7rem;
    }
    .head img {
      max-height: 90px;
      max-width: 260px;
    }
    .right {
      text-align: right;
    }
    .kind {
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .line {
      display: grid;
      grid-template-columns: 70% 30%;
    }
    .line.full {
      grid-template-columns: 100%;
    }
    .sum {
      display: grid;
      grid-template-columns: 70% 30%;
      text-align: right;
    }
    .sum span:first-child {
      padding-right: 1rem;
    }
    .sum.total {
      font-weight: 700;
      border-block: 2px solid #111;
    }
    .sign {
      align-self: flex-end;
      text-align: right;
      margin-top: 2rem;
    }
    .sign img {
      display: block;
      margin-left: auto;
      max-height: 70px;
    }
    .foot {
      margin-top: auto;
      border-top: 2px solid #111;
      padding-top: 0.5rem;
      text-align: center;
      font-size: 0.85rem;
    }
    @media (max-width: 1000px) {
      .split {
        grid-template-columns: 1fr;
      }
    }
    @media print {
      .split {
        display: block;
      }
      .paper {
        min-height: 95vh;
        padding: 0;
      }
    }
  `,
})
export class Bills implements OnInit {
  protected readonly store = injectCollection<Bill>('bills');
  private readonly ui = inject(Ui);
  protected readonly openId = signal<string | null>(null);
  protected readonly open = computed(() => this.store.byId(this.openId()));
  protected readonly sums = computed(() => {
    const bill = this.open();
    return bill ? totals(bill.items, bill.taxPercent, bill.discount) : null;
  });
  protected readonly sorted = computed(() =>
    [...this.store.items()].sort((a, b) => b.createdAt - a.createdAt),
  );
  protected readonly url = mediaUrl;
  protected readonly money = money;

  protected readonly companyFields: [TextKey, string, boolean][] = [
    ['companyName', 'Company name', false],
    ['companyTagline', 'Tagline', false],
    ['companyAddress', 'Address', true],
    ['companyPhone', 'Phone', false],
  ];
  protected readonly recipientFields: [TextKey, string, boolean][] = [
    ['recipientName', 'Recipient name', false],
    ['recipientAddress', 'Recipient address', true],
    ['salutation', 'Salutation', false],
    ['introText', 'Introduction', true],
  ];
  protected readonly closingFields: [TextKey, string, boolean][] = [
    ['signOffText', 'Closing text', true],
    ['signerName', 'Signer name', false],
    ['footerText', 'Footer (products or services)', true],
  ];

  /** Matches the server's limits, so nothing typed here can fail to save. */
  protected readonly limits: Partial<Record<TextKey, number>> = {
    companyName: 200,
    companyTagline: 200,
    companyAddress: 600,
    companyPhone: 100,
    recipientName: 200,
    recipientAddress: 600,
    salutation: 100,
    introText: 2000,
    signOffText: 300,
    signerName: 200,
    footerText: 1000,
  };

  ngOnInit(): void {
    void this.store.load();
  }

  protected total(bill: Bill): string {
    return money(totals(bill.items, bill.taxPercent, bill.discount).total, bill.currency);
  }

  protected async create(docType: Bill['docType']): Promise<void> {
    const latest = this.sorted()[0];
    const carried = latest ? Object.fromEntries(CARRIED.map((key) => [key, latest[key]])) : {};
    await this.attempt(async () => {
      const bill = await this.store.create({
        ...carried,
        docType,
        date: today(),
        billNo: nextBillNumber(
          this.store
            .items()
            .filter((b) => b.docType === docType)
            .map((b) => b.billNo),
        ),
        items: [newItem()],
      });
      this.openId.set(bill.id);
    });
  }

  protected async duplicate(bill: Bill): Promise<void> {
    const { id: _id, createdAt: _c, updatedAt: _u, parentId: _p, ...copy } = bill;
    await this.attempt(() =>
      this.store.create({
        ...copy,
        date: today(),
        billNo: nextBillNumber(
          this.store
            .items()
            .filter((b) => b.docType === bill.docType)
            .map((b) => b.billNo),
        ),
      }),
    );
  }

  protected async remove(bill: Bill): Promise<void> {
    if (await this.ui.confirm(`Delete ${bill.docType} ${bill.billNo}?`, 'This cannot be undone.')) {
      await this.attempt(() => this.store.remove(bill.id));
    }
  }

  protected close(): void {
    const id = this.openId();
    if (id) void this.store.flush(id);
    this.openId.set(null);
  }

  protected set(patch: Partial<Bill>): void {
    this.store.patch(this.openId()!, patch);
  }

  protected setText(key: TextKey, value: string): void {
    this.set({ [key]: value } as Partial<Bill>);
  }

  protected setNumber(key: 'taxPercent' | 'discount', raw: string): void {
    const value = Number(raw);
    const limit = key === 'taxPercent' ? 100 : 1e12;
    this.set({ [key]: Number.isFinite(value) ? Math.min(limit, Math.max(0, value)) : 0 });
  }

  protected setItem(id: string, patch: Partial<BillItem>): void {
    this.set({ items: this.open()!.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
  }

  protected addItem(): void {
    this.set({ items: [...this.open()!.items, newItem()] });
  }

  protected removeItem(id: string): void {
    this.set({ items: this.open()!.items.filter((i) => i.id !== id) });
  }

  protected shiftItem(index: number, by: number): void {
    this.set({ items: moveItem(this.open()!.items, index, index + by) });
  }

  protected async pickImage(key: 'companyLogoMediaId' | 'signatureMediaId'): Promise<void> {
    const billId = this.openId()!;
    const [image] = await this.ui.pickMedia(['image']);
    if (image) this.store.patch(billId, { [key]: image.id });
  }

  protected print(): void {
    window.print();
  }

  protected async exportPhoto(bill: Bill): Promise<void> {
    await this.attempt(async () => {
      downloadBlob(
        await canvasBlob(await renderBill(bill)),
        `${bill.docType}-${bill.billNo || 'draft'}.png`,
      );
    });
  }

  private async attempt(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.ui.error(error);
    }
  }
}
