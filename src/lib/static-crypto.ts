export interface EncryptedSnapshotPayload {
  v: 1;
  alg: "AES-GCM";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ct: string;
}

const PBKDF2_ITERATIONS = 100_000;

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(b64, "base64");
    const ab = new ArrayBuffer(buf.length);
    new Uint8Array(ab).set(buf);
    return new Uint8Array(ab);
  }
  const binary = atob(b64);
  const ab = new ArrayBuffer(binary.length);
  const out = new Uint8Array(ab);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function deriveAesKey(
  passcode: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  usage: KeyUsage[],
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(passcode),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    usage,
  );
}

export async function encryptJsonWithPasscode(
  data: unknown,
  passcode: string,
): Promise<EncryptedSnapshotPayload> {
  const salt = new Uint8Array(new ArrayBuffer(16));
  const iv = new Uint8Array(new ArrayBuffer(12));
  globalThis.crypto.getRandomValues(salt);
  globalThis.crypto.getRandomValues(iv);

  const key = await deriveAesKey(passcode, salt, PBKDF2_ITERATIONS, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );

  return {
    v: 1,
    alg: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(encrypted)),
  };
}

export async function decryptJsonWithPasscode<T>(
  payload: EncryptedSnapshotPayload,
  passcode: string,
): Promise<T> {
  const salt = fromBase64(payload.salt);
  const iv = fromBase64(payload.iv);
  const ct = fromBase64(payload.ct);
  const key = await deriveAesKey(passcode, salt, payload.iterations || PBKDF2_ITERATIONS, [
    "decrypt",
  ]);
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ct,
  );
  const jsonText = new TextDecoder().decode(decrypted);
  return JSON.parse(jsonText) as T;
}
