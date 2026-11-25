/**
 * Splits pasted text into one entry per sentence. Line breaks always split.
 * Uses the platform sentence segmenter so non-English punctuation (。 । ؟) works too.
 */
export function splitSentences(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const result: string[] = [];
  for (const line of lines) {
    for (const { segment } of segmenter.segment(line)) {
      const sentence = segment.trim();
      if (!sentence) continue;
      const previous = result.at(-1);
      // Re-join fragments such as list numbers ("1.") with the sentence they introduce.
      if (
        previous &&
        /^(\d{1,3}|[A-Za-z])\.$/.test(previous) &&
        line.includes(`${previous} ${sentence}`)
      ) {
        result[result.length - 1] = `${previous} ${sentence}`;
      } else {
        result.push(sentence);
      }
    }
  }
  return result;
}
