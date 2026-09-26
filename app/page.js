'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, setSession, setPrivateKeyJwk } from '../lib/supabase';
import {
  generateIdentityKeyPair, exportPublicKey, exportPrivateKeyJwk,
  randomSaltB64, deriveKeyFromPassword, encryptPrivateKey, decryptPrivateKey,
} from '../lib/crypto';

export default function LoginPage() {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  useEffect(() => {
    const s = getSession();
    if (s) router.push('/chat');
  }, [router]);

  async function handleSignup(e) {
    e.preventDefault();
    setError('');
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    setLoading(true);
    try {
      // Generate this user's identity keypair entirely in the browser.
      const keyPair = await generateIdentityKeyPair();
      const publicKeyB64 = await exportPublicKey(keyPair.publicKey);
      const privateKeyJwk = await exportPrivateKeyJwk(keyPair.privateKey);

      // Wrap the private key with a key derived from the password, so the
      // server only ever sees ciphertext, never the real private key.
      const salt = randomSaltB64();
      const passwordKey = await deriveKeyFromPassword(password, salt);
      const { ciphertext, iv } = await encryptPrivateKey(privateKeyJwk, passwordKey);
      const encrypted_private_key = JSON.stringify({ ciphertext, iv });

      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password, public_key: publicKeyB64, encrypted_private_key, salt }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Signup failed.'); setLoading(false); return; }

      const { encrypted_private_key: _epk, salt: _s, ...publicProfile } = data.user;
      setSession(publicProfile);
      setPrivateKeyJwk(privateKeyJwk);
      router.push('/chat');
    } catch (err) {
      setError('Something went wrong: ' + err.message);
      setLoading(false);
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Login failed.'); setLoading(false); return; }

      // Decrypt the private key locally using a key derived from the password.
      const passwordKey = await deriveKeyFromPassword(password, data.user.salt);
      const { ciphertext, iv } = JSON.parse(data.user.encrypted_private_key);
      const privateKeyJwk = await decryptPrivateKey(ciphertext, iv, passwordKey);

      const { encrypted_private_key, salt, ...publicProfile } = data.user;
      setSession(publicProfile);
      setPrivateKeyJwk(privateKeyJwk);
      router.push('/chat');
    } catch (err) {
      setError('Incorrect name or password.');
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={mode === 'login' ? handleLogin : handleSignup}>
        <h1>ChatApp</h1>
        <p>{mode === 'login' ? 'Log in with your name and password.' : 'Pick a name and password — no phone number needed.'}</p>
        <input type="text" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <div className="password-field">
          <input type={showPassword ? 'text' : 'password'} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="button" className="show-password-btn" onClick={() => setShowPassword((v) => !v)}>
            {showPassword ? '🙈' : '👁️'}
          </button>
        </div>
        {error && <p style={{ color: '#d33', fontSize: 13, marginBottom: 10 }}>{error}</p>}
        <button type="submit" disabled={loading}>
          {loading ? 'Please wait...' : mode === 'login' ? 'Log in' : 'Sign up'}
        </button>
        <p style={{ marginTop: 14, fontSize: 13 }}>
          {mode === 'login' ? (
            <>No account? <a href="#" onClick={(e) => { e.preventDefault(); setMode('signup'); setError(''); }}>Sign up</a></>
          ) : (
            <>Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); setMode('login'); setError(''); }}>Log in</a></>
          )}
        </p>
      </form>
    </div>
  );
}
