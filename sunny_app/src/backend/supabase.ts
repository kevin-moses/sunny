// sunny_app/src/backend/supabase.ts
//
// Purpose: The app's single Supabase client. The session lives in the Keychain through
// the chunked SecureStore adapter, refreshes automatically, and never touches URLs
// (detectSessionInUrl is off in React Native). Following Supabase's React Native
// guidance, token auto-refresh runs only while the app is active.
//
// Last modified: 2026-10-28

import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

import { SUPABASE_KEY, SUPABASE_URL } from '../config';
import { secureStorage } from './secureStorage';

/** The shared Supabase client used for Auth, RPCs, table reads and Edge Functions. */
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: secureStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

/**
 * purpose: Start or stop the Auth token refresh timer to match the app state.
 * @param state: (string) The React Native AppState value.
 */
function syncAutoRefresh(state: string): void {
  if (state === 'active') {
    void supabase.auth.startAutoRefresh();
  } else {
    void supabase.auth.stopAutoRefresh();
  }
}

syncAutoRefresh(AppState.currentState);
AppState.addEventListener('change', syncAutoRefresh);
