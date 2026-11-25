/**
 * Up to two initials for a customer's cover. Splits by whole characters as people see them,
 * so names in Hindi, Tamil and other scripts keep their vowel marks.
 */
export function initials(name: string): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const first = (word: string) => segmenter.segment(word)[Symbol.iterator]().next().value?.segment;
  const words = name.trim().split(/\s+/).filter(Boolean);
  const picked = words.length > 1 ? [words[0]!, words.at(-1)!] : words;
  return picked.map(first).join('').toLocaleUpperCase() || '?';
}
