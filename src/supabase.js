import { createClient } from "@supabase/supabase-js";

// These are injected at build time by Vite. The anon key is safe to ship to the
// client — Row-Level Security on the database is what actually protects data.
const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

// When env vars aren't set yet, the app falls back to local-only mode.
export const supabaseEnabled = !!(url && anon);

export const supabase = supabaseEnabled
  ? createClient(url, anon, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
