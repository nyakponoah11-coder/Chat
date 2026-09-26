import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../../../lib/supabaseAdmin';

export async function POST(req) {
  const { name, password } = await req.json();
  if (!name?.trim() || !password) {
    return NextResponse.json({ error: 'Name and password are required.' }, { status: 400 });
  }

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, name, avatar_color, about, public_key, encrypted_private_key, salt, password_hash')
    .ilike('name', name.trim())
    .maybeSingle();

  if (error || !user) {
    return NextResponse.json({ error: 'Incorrect name or password.' }, { status: 401 });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return NextResponse.json({ error: 'Incorrect name or password.' }, { status: 401 });
  }

  delete user.password_hash;
  return NextResponse.json({ user });
}
