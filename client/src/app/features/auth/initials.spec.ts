import { initials } from './initials';

describe('customer initials', () => {
  it('uses the first and last word', () => {
    expect(initials('Kumar Traders')).toBe('KT');
    expect(initials('  sri  lakshmi  steel works ')).toBe('SW');
    expect(initials('new')).toBe('N');
  });

  it('keeps whole characters in other scripts and emoji', () => {
    expect(initials('श्री गणेश')).toBe('श्रीग');
    expect(initials('👨‍👩‍👧 Family')).toBe('👨‍👩‍👧F');
  });

  it('has a fallback for a blank name', () => {
    expect(initials('   ')).toBe('?');
  });
});
