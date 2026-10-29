// sunny_app/src/config.ts
//
// Purpose: Build-time configuration for the app: the Supabase project URL and publishable
// key. Both are public client values, so the defaults for the hosted project live here and a
// fresh clone works without any env file (the repo ignores *.env files). Override them with
// EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_KEY in the git-ignored .env.local, for
// example to use the local Supabase stack. Expo inlines EXPO_PUBLIC_* variables only when
// they are referenced as literal `process.env.NAME`.
//
// Last modified: 2026-10-28

/** The hosted Supabase project URL (public). */
const DEFAULT_SUPABASE_URL = 'https://rlihlcgyjqyzkpzijtsp.supabase.co';

/** The hosted project's publishable (anon) key (public). */
const DEFAULT_SUPABASE_KEY = 'sb_publishable_CS4m5blzfvgnm7xbjCEp1A_mP5CuRSM';

/** The Supabase project URL: the EXPO_PUBLIC_SUPABASE_URL override, else the hosted project. */
export const SUPABASE_URL: string = process.env.EXPO_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;

/** The Supabase publishable key: the EXPO_PUBLIC_SUPABASE_KEY override, else the hosted key. */
export const SUPABASE_KEY: string = process.env.EXPO_PUBLIC_SUPABASE_KEY || DEFAULT_SUPABASE_KEY;
