# ChatApp — WhatsApp-style chat, calls, channels, status

Next.js + Supabase. Deploys to Vercel.

## What's included
- Name + **password** sign in (no phone number)
- **End-to-end encrypted messages.** Each user gets an ECDH keypair generated in
  their browser at signup. Their private key is encrypted with a key derived
  from their password (PBKDF2) before it's ever sent to the server — the
  server only ever stores/sees the encrypted blob. Every chat/group gets its
  own AES-256 key, which is wrapped individually for each member via ECDH, so
  only members holding the matching private key can unwrap it and read
  messages. Even someone with full database access sees only ciphertext.
- 1:1 chat, group chat, real-time delivery
- Broadcast "Channels" (one owner posts, everyone reads)
- Status updates (24-hour expiry)
- Voice + video calls, peer-to-peer via WebRTC (Supabase Realtime used only
  for connection signaling — no call audio/video touches the database)

## How the password + encryption pieces fit together
1. **Signup**: browser generates an ECDH keypair. The public key is sent to
   the server as-is. The private key is encrypted client-side (derived from
   your password via PBKDF2) before it's sent — so the server can store it,
   but can't read it. Your password itself is hashed with bcrypt server-side;
   the plaintext password never touches the database.
2. **Login**: the server verifies your password against the bcrypt hash and
   returns your encrypted private key blob. Your browser re-derives the same
   PBKDF2 key from your password and decrypts your private key locally.
3. **New chat**: the creator generates a random AES-256 key for that
   conversation, then wraps a copy of it for every member using ECDH between
   the creator's private key and each member's public key. Only those members
   can unwrap it.
4. **Sending a message**: encrypted client-side with the conversation's AES
   key before it's written to the database.
5. **New browser tab or fresh browser**: your decrypted private key lives only
   in `sessionStorage` (cleared when the tab closes), never `localStorage`, so
   you'll be asked for your password again to "unlock" — this is intentional,
   not a bug.

## Known limitation, stated plainly
This app authenticates with its own name+password system rather than
Supabase's built-in Auth, so the database's row-level security can't be tied
to "this is verified user X" (there's no `auth.uid()` to check against). The
`channels` / `channel_members` / `messages` / `statuses` tables use open RLS
policies as a result — **the confidentiality of message content comes from
the client-side encryption above, not from row-level database permissions.**
The `users` table itself (password hashes, encrypted private keys) *is*
properly locked down — it has no anon-accessible policies at all; only
server-side API routes with the service role key can touch it.

If you want real per-row access control on top of this, the fix is to migrate
to Supabase Auth (email/password or magic link under the hood) and rewrite
the RLS policies to check `auth.uid()`. That's a bigger change than fits
here, but the encryption layer above already gives you genuine
confidentiality of content in the meantime.

## What's simplified / not included
- **No payments.** "WhatsApp Pay" needs a licensed payment processor and
  business agreements — a legal/compliance project on its own. Ask if you'd
  like a placeholder "Send money" UI stubbed out.
- **No TURN server** for calls — a public STUN server is used, which works
  for most calls but can fail on strict corporate/mobile networks. Add a TURN
  server (Twilio, Xirsys, metered.ca — most have free tiers) to
  `ICE_SERVERS` in `components/CallPanel.js` for production reliability.
- The Settings page's "About" field currently only updates in the UI for that
  session — wire it to a small `/api/profile` route (following the pattern in
  `app/api/login/route.js`) if you want it to persist.
- No media/image messages yet — text only.
- Single device at a time for decryption convenience: your private key is
  decrypted fresh per browser tab from your password; it's not synced
  in plaintext anywhere.

## Setup

### 1. Create a Supabase project
- supabase.com → New project
- SQL editor → run everything in `supabase-schema.sql`
- Database → Replication → enable Realtime for the `messages` table
- Project Settings → API → copy the **Project URL**, **anon public key**, and
  **service_role key** (keep the service_role key secret — server-only)

### 2. Configure locally
```
cp .env.local.example .env.local
```
Fill in all three values (URL, anon key, service role key).

### 3. Run locally
```
npm install
npm run dev
```
Open http://localhost:3000

### 4. Deploy to Vercel
```
npm i -g vercel
vercel
```
Add all three environment variables in Vercel (Project → Settings →
Environment Variables) — make sure `SUPABASE_SERVICE_ROLE_KEY` is **not**
prefixed with `NEXT_PUBLIC_`, or it'll be exposed to the browser. Redeploy
after adding them.
