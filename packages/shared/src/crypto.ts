const IV_BYTES = 12;

/** Imports a base64-encoded 256-bit key as an AES-GCM CryptoKey. */
export async function importMasterKey(base64Key: string): Promise<CryptoKey> {
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
  if (keyVersion < 0 || keyVersion > 255) {
    throw new RangeError("keyVersion must fit in one byte (0-255)");
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
