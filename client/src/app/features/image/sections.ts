import { createBand, type Band } from '../../shared/band';

export type SectionKey = 'header' | 'subheader' | 'left' | 'right' | 'caption' | 'footer';

interface SectionDef {
  key: SectionKey;
  label: string;
  /** Thickness and text size relative to the photo's shorter side, applied when first shown. */
  ratio: number;
  textRatio: number;
  defaults: Partial<Band>;
}

/** In the order they stack around the photo. */
export const SECTIONS: SectionDef[] = [
  {
    key: 'header',
    label: 'Header',
    ratio: 0.12,
    textRatio: 0.45,
    defaults: { text: 'TOP HEADER' },
  },
  {
    key: 'subheader',
    label: 'Sub-header',
    ratio: 0.08,
    textRatio: 0.45,
    defaults: { text: 'Subtitle goes here', bold: false, background: '#1f2937' },
  },
  {
    key: 'left',
    label: 'Left side',
    ratio: 0.09,
    textRatio: 0.45,
    defaults: { text: 'LEFT', background: '#374151' },
  },
  {
    key: 'right',
    label: 'Right side',
    ratio: 0.09,
    textRatio: 0.45,
    defaults: { text: 'RIGHT', background: '#374151' },
  },
  {
    key: 'caption',
    label: 'Caption',
    ratio: 0.09,
    textRatio: 0.4,
    defaults: {
      text: 'Write a caption…',
      bold: false,
      italic: true,
      align: 'left',
      background: '#f9fafb',
      color: '#111827',
      borderWidth: 1,
      borderColor: '#d1d5db',
    },
  },
  {
    key: 'footer',
    label: 'Footer',
    ratio: 0.12,
    textRatio: 0.45,
    defaults: { text: 'BOTTOM FOOTER' },
  },
];

export const emptySections = (): Record<SectionKey, Band> =>
  Object.fromEntries(
    SECTIONS.map((s) => [s.key, createBand({ ...s.defaults, size: 0 })]),
  ) as Record<SectionKey, Band>;

/** Gives a section a size that suits the photo the first time it is switched on. */
export function sizeForPhoto(key: SectionKey, band: Band, shorterSide: number): Band {
  if (band.size > 0) return band;
  const def = SECTIONS.find((s) => s.key === key)!;
  const size = Math.max(24, Math.round(shorterSide * def.ratio));
  return { ...band, size, fontSize: Math.max(10, Math.round(size * def.textRatio)) };
}
