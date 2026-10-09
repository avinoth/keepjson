import { z } from "@hono/zod-openapi";
import { RATE_LIMIT_PERIOD_SECONDS } from "./bins/rate-limit";
import { ERROR_CODES, type ErrorCode } from "./errors";

// The OpenAPI description of the contract in docs/api.md. Schemas here only describe requests and responses: request
// headers, path parameters and bodies are never given to zod-openapi as Zod schemas, so it validates nothing itself
// and the handlers keep their own checks, order and error codes (docs/api.md → Validation and errors).

/** The name of the `Authorization: Bearer <key>` security scheme. */
export const BEARER_AUTH = "bearerAuth";

/** An operation's security requirements: each entry is one way to be allowed, and `{}` means no key at all. */
type SecurityRequirements = Record<string, string[]>[];

/** The operation needs a key. */
export const REQUIRED_BEARER_AUTH: SecurityRequirements = [{ [BEARER_AUTH]: [] }];

/** The operation takes a key, but may need none: a public Bin can be read without one. */
export const OPTIONAL_BEARER_AUTH: SecurityRequirements = [{}, { [BEARER_AUTH]: [] }];

/** The `info` of the spec served at `/openapi.json`. */
export const SPEC_INFO = {
  title: "keepjson",
  // The version of the contract in docs/api.md.
  version: "0.1.0",
  description: [
    "Store JSON without an account: one call saves a Bin, one call fetches it.",
    "",
    "- A Bin's body is the raw JSON, with no envelope. Its metadata travels in `X-Bin-*` response headers.",
    "- Creating a Bin returns a Write Key, and a Read Key as well for a Private Bin. Keys are shown only once.",
    "  Send one as `Authorization: Bearer <key>`.",
    "- Timestamps are ISO 8601 UTC. Every response sends `Cache-Control: no-store`.",
    "- Errors are `{ error: { code, message } }`.",
    "",
    "A Write Key embedded in frontend code gives every visitor write access to its Bin.",
  ].join("\n"),
};

/** An ISO 8601 UTC timestamp, as in headers and JSON bodies. */
export const IsoTimestamp = z.iso.datetime().openapi({ example: "2026-10-09T12:00:00.000Z" });

/** The error response body of docs/api.md → Conventions, shared by every error. */
export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES).openapi({ description: "Stable and machine-readable: branch on this." }),
      message: z.string().openapi({ description: "Readable by people. It may change." }),
    }),
  })
  .openapi("Error", { description: "Every error response has this shape." });

type ErrorBody = z.infer<typeof ErrorSchema>;

/** Each error code's status, when it is sent (docs/api.md → Validation and errors) and an example message. */
const ERRORS = {
  invalid_json: { status: 400, when: "The body isn't valid JSON.", message: "Body is not valid JSON" },
  invalid_ttl: {
    status: 400,
    when: "`X-Bin-TTL` isn't a positive integer, or is larger than the Instance's maximum TTL.",
    message: "X-Bin-TTL must be a positive integer of seconds",
  },
  unauthorized: {
    status: 401,
    when: "A key is needed and none was sent.",
    message: "This Bin needs a key: send Authorization: Bearer <key>",
  },
  forbidden: {
    status: 403,
    when: "The key sent doesn't grant this action.",
    message: "The key sent doesn't grant this",
  },
  not_found: {
    status: 404,
    when: "Unknown id, malformed id, or an expired Bin (these can't be told apart).",
    message: "Bin not found",
  },
  payload_too_large: {
    status: 413,
    when: "The body is larger than the Instance's `MAX_BIN_BYTES`.",
    message: "Body is larger than 102400 bytes",
  },
  unsupported_media_type: {
    status: 415,
    when: "`Content-Type` isn't `application/json`.",
    message: "Content-Type must be application/json",
  },
  invalid_top_level: {
    status: 422,
    when: "Valid JSON, but not an object or array.",
    message: "Body must be a JSON object or array",
  },
  rate_limited: {
    status: 429,
    when: "Rate limit exceeded: wait `Retry-After` seconds.",
    message: "Too many requests: try again later",
  },
  internal_error: {
    status: 500,
    when: "An unexpected server error. The details are not returned.",
    message: "Internal error",
  },
} as const satisfies Record<ErrorCode, { status: number; when: string; message: string }>;

type ErrorStatus<C extends ErrorCode> = (typeof ERRORS)[C]["status"];

const RetryAfterHeaders = z.object({
  "Retry-After": z
    .number()
    .int()
    .positive()
    .openapi({ description: "Seconds to wait before trying again.", example: RATE_LIMIT_PERIOD_SECONDS }),
});

type ErrorResponseConfig = {
  description: string;
  headers?: typeof RetryAfterHeaders;
  content: {
    "application/json": {
      schema: typeof ErrorSchema;
      examples: Record<string, { summary: string; value: ErrorBody }>;
    };
  };
};

/**
 * The error responses of a route, one per status, for the given codes: each uses the shared error schema and shows
 * an example of every code it can carry. A `429` also describes `Retry-After`.
 */
export function errorResponses<C extends ErrorCode>(...codes: C[]): { [S in ErrorStatus<C>]: ErrorResponseConfig } {
  const responses: Record<number, ErrorResponseConfig> = {};
  for (const code of codes) {
    const { status, when, message } = ERRORS[code];
    responses[status] ??= { description: "", content: { "application/json": { schema: ErrorSchema, examples: {} } } };
    const response = responses[status];
    response.description = [response.description, `\`${code}\`: ${when}`].filter(Boolean).join("\n\n");
    response.content["application/json"].examples[code] = { summary: code, value: { error: { code, message } } };
    if (status === 429) response.headers = RetryAfterHeaders;
  }
  return responses as { [S in ErrorStatus<C>]: ErrorResponseConfig };
}

/** The page at `/docs`: Swagger UI, loaded from a CDN at a pinned version and checked with SRI, reading `specUrl`. */
export function docsPage(specUrl: string): string {
  const cdn = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.32.15";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>keepjson API</title>
    <link rel="stylesheet" href="${cdn}/swagger-ui.css" integrity="sha384-fgyWYkUAamzuI8mJFu/xpRP0JWCJRwkwUwsYDoOYVHUJ8NQE5cENn8ib3ppwFFSX" crossorigin="anonymous">
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${cdn}/swagger-ui-bundle.js" integrity="sha384-m7zaGj7MPzU+G4lz2eyy73GxK9bbRDr9bB2CSdj8wodg2wu/Wnt6wsoLP3JD+RS9" crossorigin="anonymous"></script>
    <script>
      window.ui = SwaggerUIBundle({ url: ${JSON.stringify(specUrl)}, dom_id: "#swagger-ui" });
    </script>
  </body>
</html>
`;
}
