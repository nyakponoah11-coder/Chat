import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// Non-sensitive profile info, kept across browser restarts so you don't have
// to retype your name every visit. No password or private key lives here.
export function getSession() {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem('chatapp_user');
  return raw ? JSON.parse(raw) : null;
}
export function setSession(user) {
  localStorage.setItem('chatapp_user', JSON.stringify(user));
}
export function clearSession() {
  localStorage.removeItem('chatapp_user');
  sessionStorage.removeItem('chatapp_privatekey');
}

// The decrypted private key only ever lives in sessionStorage (cleared when
// the tab/browser closes), never localStorage, and it's derived fresh from
// your password each time you unlock — it's never sent to or stored on the
// server in this form.
export function getPrivateKeyJwk() {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem('chatapp_privatekey');
}
export function setPrivateKeyJwk(jwkStr) {
  sessionStorage.setItem('chatapp_privatekey', jwkStr);
}
