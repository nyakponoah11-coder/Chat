import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../../../lib/supabaseAdmin';

export async function POST(req) {
  const { name, password, public_key, encrypted_private_key, salt } = await req.json();

  if (!name?.trim() || !password || password.length < 6) {
    return NextResponse.json({ error: 'Name and a password of at least 6 characters are required.' }, { status: 400 });
  }

  const { data: existing } = await supabaseAdmin
    .from('users')
    .select('id')
    .ilike('name', name.trim())
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ error: 'That name is already taken. Try logging in instead.' }, { status: 409 });
  }

  const password_hash = await bcrypt.hash(password, 10);

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .insert({
      name: name.trim(),
      password_hash,
      salt,
      public_key,
      encrypted_private_key,
      avatar_color: pickColor(name.trim()),
    })
    .select('id, name, avatar_color, about, public_key, encrypted_private_key, salt')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ user });
}

function pickColor(name) {
  const colors = ['#25D366', '#128C7E', '#075E54', '#34B7F1', '#FF7A5C', '#7A5CFF'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash += name.charCodeAt(i);
  return colors[hash % colors.length];
}
