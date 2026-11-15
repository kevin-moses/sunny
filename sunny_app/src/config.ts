const DEFAULT_CONVEX_URL = 'https://enduring-ostrich-959.convex.cloud';

const DEFAULT_CLERK_PUBLISHABLE_KEY =
  'pk_test_c2hhcmluZy1yb2Jpbi0xNTk5LmNsZXJrLmFjY291bnRzLmRldiQ=';

export function deriveSiteUrl(convexUrl: string): string {
  return convexUrl.replace(/\.convex\.cloud\/?$/, '.convex.site');
}

export const CONVEX_URL: string = process.env.EXPO_PUBLIC_CONVEX_URL || DEFAULT_CONVEX_URL;

export const CONVEX_SITE_URL: string =
  process.env.EXPO_PUBLIC_CONVEX_SITE_URL || deriveSiteUrl(CONVEX_URL);

export const CLERK_PUBLISHABLE_KEY: string =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? DEFAULT_CLERK_PUBLISHABLE_KEY;
