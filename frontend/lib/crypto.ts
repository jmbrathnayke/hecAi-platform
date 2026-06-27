// AES-GCM field encryption for privacy-sensitive data (NIC, mobile) before it is
// written to IndexedDB. NFR-3.1: plaintext NIC/mobile must NEVER touch IndexedDB.
//
// Authenticated officers (Story 3.1) will derive the key from the Supabase JWT;
// anonymous citizens use a non-extractable device key persisted in IndexedDB
// (stored as a CryptoKey object via structured clone — never exported as raw bytes).
import { getSessionValue, putSessionValue } from "@/lib/indexeddb";

const CITIZEN_KEY_ID = "citizen-key";

export async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // not extractable
    ["encrypt", "decrypt"],
  );
}

export async function encryptField(
  plaintext: string,
  key: CryptoKey,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    ciphertext: toBase64(new Uint8Array(encrypted)),
    iv: toBase64(iv),
  };
}

export async function decryptField(
  ciphertext: string,
  iv: string,
  key: CryptoKey,
): Promise<string> {
  const ivBytes = fromBase64(iv);
  const ciphertextBytes = fromBase64(ciphertext);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    key,
    ciphertextBytes,
  );
  return new TextDecoder().decode(decrypted);
}

// Shared in-flight promise so concurrent callers don't each generate (and persist)
// a different key — divergent non-extractable keys would make data permanently
// undecryptable. Mirrors the openDB() singleton pattern.
let keyPromise: Promise<CryptoKey> | null = null;

/**
 * Returns the anonymous citizen's device key, creating and persisting it on first use.
 * The key is non-extractable; only the live CryptoKey object is stored in IndexedDB.
 */
export async function getOrCreateSessionKey(): Promise<CryptoKey> {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const existing = (await getSessionValue(CITIZEN_KEY_ID)) as
      | { id: string; key: CryptoKey }
      | undefined;
    if (existing?.key) return existing.key;
    const key = await generateKey();
    await putSessionValue({ id: CITIZEN_KEY_ID, key });
    return key;
  })();
  try {
    return await keyPromise;
  } catch (err) {
    keyPromise = null; // allow retry on failure
    throw err;
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  // Return type is explicitly ArrayBuffer-backed: TS 5.7's default Uint8Array
  // (ArrayBufferLike) is not assignable to BufferSource for crypto.subtle args.
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
