import { describe, expect, it } from '@jest/globals';

import { deriveSiteUrl } from '../config';

describe('deriveSiteUrl', () => {
  it('swaps .convex.cloud for .convex.site', () => {
    expect(deriveSiteUrl('https://enduring-ostrich-959.convex.cloud')).toBe(
      'https://enduring-ostrich-959.convex.site',
    );
  });

  it('ignores a trailing slash', () => {
    expect(deriveSiteUrl('https://x-1.convex.cloud/')).toBe('https://x-1.convex.site');
  });

  it('leaves other hosts unchanged', () => {
    expect(deriveSiteUrl('http://127.0.0.1:3210')).toBe('http://127.0.0.1:3210');
  });
});
