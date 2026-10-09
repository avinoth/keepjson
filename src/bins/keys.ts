import { nanoid } from "nanoid";

const BIN_ID_PATTERN = /^[A-Za-z0-9_-]{21}$/;
const KEY_BYTES = 32;

/** A new Bin id: 21 URL-safe characters (about 126 bits). */
export function generateBinId(): string {
  return nanoid();
}

export function isValidBinId(id: string): boolean {
  return BIN_ID_PATTERN.test(id);
}

/** A new Write Key: `kj_w_` + 32 random bytes in base64url. Shown once, never stored. */
export function generateWriteKey(): string {
  return `kj_w_${randomBase64Url(KEY_BYTES)}`;
}

/** A new Read Key: `kj_r_` + 32 random bytes in base64url. Shown once, never stored. */
export function generateReadKey(): string {
  return `kj_r_${randomBase64Url(KEY_BYTES)}`;
}

/** The hex SHA-256 of a key: the only form in which a key is stored. */
export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether `key` hashes to `expectedHash`, compared in constant time. */
export async function matches(key: string, expectedHash: string): Promise<boolean> {
  const actual = new TextEncoder().encode(await hashKey(key));
  const expected = new TextEncoder().encode(expectedHash);
  // Both are hex SHA-256 digests, so the lengths only differ for a malformed stored hash.
  if (actual.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(actual, expected);
}

function randomBase64Url(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
