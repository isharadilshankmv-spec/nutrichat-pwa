import { createClient } from "@supabase/supabase-js";

// These are injected at build time by Vite. The anon key is safe to ship to the
// client — Row-Level Security on the database is what actually protects data.
// Normalize the URL: trim whitespace, drop trailing slashes, and strip an
// accidentally-pasted "/rest/v1" or "/auth/v1" suffix so we always end up with
// the base project URL (otherwise the SDK builds bad paths like /rest/v1/auth/v1).
const url = (import.meta.env.VITE_SUPABASE_URL || "")
  .trim()
  .replace(/\/+$/, "")
  .replace(/\/(rest|auth|storage)\/v1$/, "")
  .replace(/\/+$/, "");
const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();

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
