const IV_BYTES = 12;
const MAX_KEY_VERSION = 255; // key version is packed into a single byte

/** Imports a base64-encoded 256-bit key as an AES-GCM CryptoKey. */
export function importMasterKey(base64Key: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypts plaintext, prefixing the output with a key-version byte so the
 * master key can rotate later without a full re-encrypt migration.
 */
export async function encrypt(
  plaintext: string,
  key: CryptoKey,
  keyVersion: number
): Promise<string> {
  if (keyVersion < 0 || keyVersion > MAX_KEY_VERSION) {
    throw new RangeError(
      `keyVersion must fit in one byte (0-${MAX_KEY_VERSION})`
    );
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext)
    )
  );

  const packed = new Uint8Array(1 + IV_BYTES + ciphertext.length);
  packed[0] = keyVersion;
  packed.set(iv, 1);
  packed.set(ciphertext, 1 + IV_BYTES);

  return btoa(String.fromCharCode(...packed));
}

/**
 * Decrypts a value produced by `encrypt`. `keysByVersion` must contain every
 * key version still in use, so old ciphertext keeps decrypting mid-rotation.
 */
export async function decrypt(
  packedBase64: string,
  keysByVersion: Record<number, CryptoKey>
): Promise<string> {
  const packed = Uint8Array.from(atob(packedBase64), (c) => c.charCodeAt(0));
  const keyVersion = packed[0];
  const key = keyVersion === undefined ? undefined : keysByVersion[keyVersion];
  if (!key) {
    throw new Error(`no key for version ${keyVersion}`);
  }

  const iv = packed.slice(1, 1 + IV_BYTES);
  const ciphertext = packed.slice(1 + IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}

/** Imports a base64-encoded secret as an HMAC-SHA256 signing key. */
export function importSigningKey(base64Key: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Signs a payload into an opaque OAuth `state` value: base64url(payload).base64url(signature).
 * Lets the callback route recover which DO to wake up (e.g. `do_name`) without a lookup table,
 * while a forged/tampered state fails verification instead of routing to an arbitrary DO.
 */
export async function signState(
  payload: string,
  key: CryptoKey
): Promise<string> {
  const encoded = base64url(new TextEncoder().encode(payload));
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encoded)
  );
  return `${encoded}.${base64url(new Uint8Array(signature))}`;
}

/** Verifies a `state` value produced by `signState`; returns the payload or null if invalid. */
export async function verifyState(
  state: string,
  key: CryptoKey
): Promise<string | null> {
  const [encoded, signature] = state.split(".");
  if (!(encoded && signature)) {
    return null;
  }
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encoded)
  );
  const actual = fromBase64url(signature);
  const expectedBytes = new Uint8Array(expected);
  if (actual.length !== expectedBytes.length) {
    return null;
  }
  // Constant-time comparison: XOR every byte instead of an early-exit `!==`,
  // so verification takes the same time whether the signature is right or
  // wrong at byte 0 or byte 31 — an early-exit compare leaks that timing.
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    // biome-ignore lint/suspicious/noBitwiseOperators: bitwise XOR/OR is the point — a branching comparison here would leak timing
    diff |= (actual[i] ?? 0) ^ (expectedBytes[i] ?? 0);
  }
  return diff === 0 ? new TextDecoder().decode(fromBase64url(encoded)) : null;
}

const PLUS_CHAR = /\+/g;
const SLASH_CHAR = /\//g;
const TRAILING_PADDING = /=+$/;
const URL_DASH = /-/g;
const URL_UNDERSCORE = /_/g;

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(PLUS_CHAR, "-")
    .replace(SLASH_CHAR, "_")
    .replace(TRAILING_PADDING, "");
}

const BASE64_BLOCK_SIZE = 4;

export function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(URL_DASH, "+").replace(URL_UNDERSCORE, "/");
  const remainder = padded.length % BASE64_BLOCK_SIZE;
  const padLength = remainder === 0 ? 0 : BASE64_BLOCK_SIZE - remainder;
  const base64 = padded.padEnd(padded.length + padLength, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
