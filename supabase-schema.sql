-- Run this in Supabase SQL editor.
-- If you already ran the old schema, drop the old tables first:
-- drop table if exists messages, statuses, channel_members, channels, users cascade;

create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  password_hash text not null,          -- bcrypt hash, only touched by server API routes
  salt text not null,                    -- base64 PBKDF2 salt, used to derive a key from the password to decrypt the private key below
  public_key text not null,              -- base64 ECDH public key (safe to share)
  encrypted_private_key text not null,   -- ECDH private key, encrypted client-side with a password-derived key before it ever reaches the server
  avatar_color text default '#25D366',
  about text default 'Hey there! I am using ChatApp.',
  created_at timestamptz default now(),
  last_seen timestamptz default now()
);

create table channels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_group boolean default false,
  is_broadcast boolean default false,
  created_by uuid references users(id),
  created_at timestamptz default now()
);

create table channel_members (
  channel_id uuid references channels(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  encrypted_channel_key text,  -- the channel's AES key, wrapped for this member via ECDH shared secret with the channel creator
  key_iv text,
  joined_at timestamptz default now(),
  primary key (channel_id, user_id)
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid references channels(id) on delete cascade,
  sender_id uuid references users(id),
  ciphertext text not null,   -- AES-GCM encrypted message content, base64
  iv text not null,
  type text default 'text',
  created_at timestamptz default now()
);

create table statuses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  content text,
  created_at timestamptz default now(),
  expires_at timestamptz default (now() + interval '24 hours')
);

-- Enable Realtime on: messages (Database > Replication in the Supabase dashboard)

-- ===== Row Level Security =====
alter table users enable row level security;
alter table channels enable row level security;
alter table channel_members enable row level security;
alter table messages enable row level security;
alter table statuses enable row level security;

-- users: no policies for anon/authenticated at all -> the app's anon key can
-- never read or write this table directly. Signup/login only happen through
-- the server API routes, which use the Supabase service role key and bypass RLS.
-- (This is what actually protects password_hash and encrypted_private_key.)

-- A safe public view of user profiles, for the "new chat" picker etc.
create view public_users as
  select id, name, avatar_color, about, public_key, created_at, last_seen
  from users;
grant select on public_users to anon, authenticated;

-- channels / channel_members / messages / statuses: kept open (using(true))
-- because this app authenticates with its own name+password system rather
-- than Supabase Auth, so there's no auth.uid() for RLS to check against.
-- Confidentiality of message content comes from client-side encryption, not
-- from these row policies. See README for how to lock this down further with
-- Supabase Auth if you need real per-row access control.
create policy "open channels" on channels for all using (true) with check (true);
create policy "open channel_members" on channel_members for all using (true) with check (true);
create policy "open messages" on messages for all using (true) with check (true);
create policy "open statuses" on statuses for all using (true) with check (true);
