import type { Context } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./context";

/** The request headers a browser may send. */
export const CORS_ALLOWED_HEADERS = ["Authorization", "Content-Type", "X-Bin-Private", "X-Bin-TTL"];

/**
 * The response headers a browser may read: the `X-Bin-*` metadata, `Location` on create, and
 * `Retry-After` on `429`, none of which are CORS-safelisted.
 */
export const CORS_EXPOSED_HEADERS = [
  "X-Bin-Id",
  "X-Bin-Private",
  "X-Bin-Created-At",
  "X-Bin-Updated-At",
  "X-Bin-Expires-At",
  "Location",
  "Retry-After",
];

/**
 * CORS for every route, driven by `CORS_ORIGINS`. Needs `withConfig` first. `*` allows any
 * origin; an allowlist echoes the request's `Origin` only on an exact match and otherwise sends no
 * `Access-Control-Allow-Origin`. Preflights are answered here with `204`, before rate limiting and D1. No
 * credentials: keys travel in the `Authorization` header, not in cookies.
 */
export const withCors = cors({
  origin: (origin: string, c: Context<AppEnv>) => {
    const allowed = c.var.config.corsOrigins;
    if (allowed === "*") return "*";
    return allowed.includes(origin) ? origin : null;
  },
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: CORS_ALLOWED_HEADERS,
  exposeHeaders: CORS_EXPOSED_HEADERS,
});
