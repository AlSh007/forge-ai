import { createClient } from '@supabase/supabase-js';

// Public (anon) Supabase client used only for auth on the browser. The anon key is
// designed to be public; all data access still goes through our authenticated API.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Don't throw — that would break `next build` in CI where env isn't set. A
  // placeholder keeps the module loadable; auth simply won't work until the real
  // NEXT_PUBLIC_SUPABASE_* vars are provided (locally / on Vercel).
  // eslint-disable-next-line no-console
  console.warn(
    '[supabase] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set — ' +
      'authentication will not work until they are configured.'
  );
}

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = createClient(
  url || 'https://placeholder.supabase.co',
  anonKey || 'placeholder-anon-key'
);
