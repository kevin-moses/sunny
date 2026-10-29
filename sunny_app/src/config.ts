// sunny_app/src/config.ts
//
// Purpose: Build-time configuration: the Convex deployment URL, the Convex HTTP actions
// ("site") URL and the Clerk publishable key. All are public client values with defaults for
// the hosted deployment and the Clerk dev instance, so a fresh clone works without an env file.
// Override with EXPO_PUBLIC_CONVEX_URL, EXPO_PUBLIC_CONVEX_SITE_URL (derived from the Convex
// URL by default: ".convex.cloud" becomes ".convex.site") and EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY
// in the git-ignored .env.local. Expo inlines EXPO_PUBLIC_* variables only when they are
// referenced as literal `process.env.NAME`.
//
// Last modified: 2026-10-29

/** The hosted Convex deployment URL (public). */
const DEFAULT_CONVEX_URL = 'https://enduring-ostrich-959.convex.cloud';

/** The Clerk dev instance (sharing-robin-1599) publishable key (public). */
const DEFAULT_CLERK_PUBLISHABLE_KEY =
  'pk_test_c2hhcmluZy1yb2Jpbi0xNTk5LmNsZXJrLmFjY291bnRzLmRldiQ=';

/**
 * purpose: Derive the Convex HTTP actions URL from the Convex client URL.
 * @param convexUrl: (string) The deployment URL, for example https://name-123.convex.cloud.
 * @return: (string) The same host with the ".convex.site" suffix; the input unchanged when it
 *          does not end in ".convex.cloud" (for example a local deployment).
 */
export function deriveSiteUrl(convexUrl: string): string {
  return convexUrl.replace(/\.convex\.cloud\/?$/, '.convex.site');
}

/** The Convex deployment URL: the EXPO_PUBLIC_CONVEX_URL override, else the hosted one. */
export const CONVEX_URL: string = process.env.EXPO_PUBLIC_CONVEX_URL || DEFAULT_CONVEX_URL;

/** The Convex HTTP actions URL: the override, else derived from CONVEX_URL. */
export const CONVEX_SITE_URL: string =
  process.env.EXPO_PUBLIC_CONVEX_SITE_URL || deriveSiteUrl(CONVEX_URL);

/**
 * The Clerk publishable key: the env override, else the dev instance key. An empty override
 * shows ConfigErrorScreen.
 */
export const CLERK_PUBLISHABLE_KEY: string =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? DEFAULT_CLERK_PUBLISHABLE_KEY;
