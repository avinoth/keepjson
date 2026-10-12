import type { Config } from "../config";
import { ApiError } from "../errors";
import { deleteExpired } from "./repository";

/** The latest instant a JS Date can hold (unix ms); an Expiry past it couldn't be sent as an ISO timestamp. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * The Expiry (unix ms) of a Bin created at `now`, or null when it never expires, following the Expiry rules.
 * `header` is the `X-Bin-TTL` request header, or null/undefined when it wasn't sent.
 *
 * - Header sent: it must be a positive integer of seconds (ASCII digits only, surrounding whitespace ignored) and
 *   not above the Instance's maximum, else `400 invalid_ttl`. An empty value was still sent, so it is invalid too.
 *   A TTL so large that it isn't a safe integer, or that puts the Expiry past the largest Date, is also invalid.
 * - No header: the Instance's default TTL if set, otherwise its maximum if set, otherwise no Expiry.
 */
export function resolveExpiresAt(header: string | null | undefined, config: Config, now: number): number | null {
  if (header === null || header === undefined) {
    const ttlSeconds = config.defaultTtlSeconds || config.maxTtlSeconds;
    return ttlSeconds > 0 ? now + ttlSeconds * 1000 : null;
  }

  const value = header.trim();
  const ttlSeconds = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new ApiError(400, "invalid_ttl", "X-Bin-TTL must be a positive integer of seconds");
  }
  if (config.maxTtlSeconds > 0 && ttlSeconds > config.maxTtlSeconds) {
    throw new ApiError(400, "invalid_ttl", `X-Bin-TTL must be at most ${config.maxTtlSeconds} seconds`);
  }

  const expiresAt = now + ttlSeconds * 1000;
  if (expiresAt > MAX_DATE_MS) throw new ApiError(400, "invalid_ttl", "X-Bin-TTL is too large");
  return expiresAt;
}

export type SweepOptions = {
  /** Bins deleted per statement. */
  batchSize?: number;
  /** Once this many ms have passed since the sweep started, no further batch is started. */
  budgetMs?: number;
  /** The clock the budget is measured with (unix ms). */
  clock?: () => number;
};

/**
 * Deletes Bins whose Expiry is at or before `now`, `batchSize` at a time, until a batch comes back short (nothing
 * expired is left) or the time budget has run out; what is left goes to the next run. At least one batch always
 * runs. Returns how many Bins were deleted.
 */
export async function sweepExpired(
  db: D1Database,
  now: number,
  { batchSize = 500, budgetMs = 20_000, clock = Date.now }: SweepOptions = {},
): Promise<number> {
  const startedAt = clock();
  let total = 0;
  for (;;) {
    const deleted = await deleteExpired(db, now, batchSize);
    total += deleted;
    if (deleted < batchSize || clock() - startedAt >= budgetMs) return total;
  }
}
