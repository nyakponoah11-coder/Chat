// All crypto here runs in the browser via the Web Crypto API.
// Private keys and passwords never leave the browser in plaintext.

function b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function unb64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// ---- Identity keypair (ECDH P-256), generated once at signup ----
export async function generateIdentityKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
}

export async function exportPublicKey(publicKey) {
  const raw = await crypto.subtle.exportKey('spki', publicKey);
  return b64(raw);
}
export async function importPublicKey(b64Str) {
  return crypto.subtle.importKey('spki', unb64(b64Str), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}
export async function exportPrivateKeyJwk(privateKey) {
  return JSON.stringify(await crypto.subtle.exportKey('jwk', privateKey));
}
export async function importPrivateKeyJwk(jwkStr) {
  return crypto.subtle.importKey('jwk', JSON.parse(jwkStr), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
}

// ---- Deriving a key from the user's password, to wrap their private key ----
export function randomSaltB64() {
  return b64(crypto.getRandomValues(new Uint8Array(16)));
}
export async function deriveKeyFromPassword(password, saltB64) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations: 150000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptPrivateKey(privateKeyJwkStr, passwordKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, passwordKey, new TextEncoder().encode(privateKeyJwkStr));
  return { ciphertext: b64(ciphertext), iv: b64(iv) };
}
export async function decryptPrivateKey(ciphertextB64, ivB64, passwordKey) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, passwordKey, unb64(ciphertextB64));
  return new TextDecoder().decode(plain);
}

// ---- ECDH shared secret between two people, used to wrap a channel key ----
async function deriveSharedKey(myPrivateKey, theirPublicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPublicKey },
    myPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ---- Per-channel AES-256 key, wrapped individually for each member ----
export async function generateChannelKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function exportRawKey(key) {
  return b64(await crypto.subtle.exportKey('raw', key));
}
async function importRawKey(b64Str) {
  return crypto.subtle.importKey('raw', unb64(b64Str), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

// Wrap a freshly-generated channel key for one member, using ECDH between
// the channel creator's private key and that member's public key.
export async function wrapChannelKeyForMember(channelKey, creatorPrivateKey, memberPublicKeyB64) {
  const memberPublicKey = await importPublicKey(memberPublicKeyB64);
  const sharedKey = await deriveSharedKey(creatorPrivateKey, memberPublicKey);
  const raw = await exportRawKey(channelKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, new TextEncoder().encode(raw));
  return { encrypted_channel_key: b64(ciphertext), key_iv: b64(iv) };
}

// A member unwraps their copy of the channel key using ECDH between their
// own private key and the channel creator's public key.
export async function unwrapChannelKey(encryptedKeyB64, ivB64, myPrivateKey, creatorPublicKeyB64) {
  const creatorPublicKey = await importPublicKey(creatorPublicKeyB64);
  const sharedKey = await deriveSharedKey(myPrivateKey, creatorPublicKey);
  const rawB64Bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, sharedKey, unb64(encryptedKeyB64));
  const rawB64 = new TextDecoder().decode(rawB64Bytes);
  return importRawKey(rawB64);
}

// ---- Encrypting / decrypting actual message text with a channel's key ----
export async function encryptMessage(channelKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, channelKey, new TextEncoder().encode(plaintext));
  return { ciphertext: b64(ciphertext), iv: b64(iv) };
}
export async function decryptMessage(channelKey, ciphertextB64, ivB64) {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, channelKey, unb64(ciphertextB64));
    return new TextDecoder().decode(plain);
  } catch (e) {
    return '[unable to decrypt]';
  }
}
