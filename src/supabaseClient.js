import { createClient } from "@supabase/supabase-js";

// These two values come from your Supabase project (Project Settings -> API).
// They are meant to be public — safe to ship in the browser bundle — because
// Row Level Security on the database is what actually protects the data, not
// secrecy of these values. Set them in a .env file (see .env.example);
// never hardcode them here.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    "Missing Supabase configuration. Copy .env.example to .env and paste in your project URL and anon key."
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
