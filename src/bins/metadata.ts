import type { Bin } from "./repository";

/** Unix ms as an ISO 8601 UTC timestamp. */
export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The `X-Bin-*` response headers on every Bin response. */
export function binMetadataHeaders(bin: Bin): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Bin-Id": bin.id,
    "X-Bin-Private": String(bin.isPrivate),
    "X-Bin-Created-At": toIso(bin.createdAt),
    "X-Bin-Updated-At": toIso(bin.updatedAt),
  };
  if (bin.expiresAt !== null) headers["X-Bin-Expires-At"] = toIso(bin.expiresAt);
  return headers;
}
