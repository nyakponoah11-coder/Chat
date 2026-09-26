import { createClient } from '@supabase/supabase-js';

// This uses the SERVICE ROLE key and must only ever be imported from
// server-side code (API routes). It bypasses Row Level Security, which is
// exactly why it's the only thing allowed to touch password_hash /
// encrypted_private_key on the users table. Never import this file from
// anything in app/ that isn't inside app/api/.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
