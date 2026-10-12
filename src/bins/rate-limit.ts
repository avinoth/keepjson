import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context";
import { errorResponse } from "../errors";

/**
 * The period of both limiter bindings, in seconds: keep it equal to `ratelimits[].simple.period` in wrangler.jsonc.
 * A binding can't report when its window resets, so `Retry-After` sends the whole period.
 */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/**
 * The limiter key for a request without `CF-Connecting-IP` (Cloudflare always sets it, so only local or unusual
 * traffic lacks it). All such requests share this one bucket rather than going unlimited.
 */
export const MISSING_IP_KEY = "unknown";

/** The rate limit bindings in wrangler.jsonc. */
export type LimiterBinding = "CREATE_LIMITER" | "WRITE_LIMITER";

/**
 * Checks `binding` for the client's IP and answers `429 rate_limited` with `Retry-After` when it is over the limit
 *. Needs `withConfig` first. With `RATE_LIMIT_ENABLED=false` the limiter isn't called.
 */
export function rateLimit(binding: LimiterBinding) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.var.config.rateLimitEnabled) {
      const key = c.req.header("CF-Connecting-IP")?.trim() || MISSING_IP_KEY;
      const { success } = await c.env[binding].limit({ key });
      if (!success) {
        c.header("Retry-After", String(RATE_LIMIT_PERIOD_SECONDS));
        return errorResponse(c, 429, "rate_limited", "Too many requests: try again later");
      }
    }
    await next();
  });
}
