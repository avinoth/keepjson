import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** The error codes an error response can carry. */
export const ERROR_CODES = [
  "invalid_json",
  "invalid_ttl",
  "unauthorized",
  "forbidden",
  "not_found",
  "payload_too_large",
  "unsupported_media_type",
  "invalid_top_level",
  "rate_limited",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Thrown anywhere in a request; `app.onError` turns it into the error response. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** `{ "error": { "code", "message" } }` with the given status. */
export function errorResponse(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string): Response {
  return c.json({ error: { code, message } }, status);
}
