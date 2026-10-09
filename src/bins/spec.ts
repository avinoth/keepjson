import { createRoute, z } from "@hono/zod-openapi";
import { errorResponses, IsoTimestamp, OPTIONAL_BEARER_AUTH, REQUIRED_BEARER_AUTH } from "../openapi";

// The OpenAPI routes for Bins (docs/api.md → Routes). Request headers, the id and the body are described as plain
// OpenAPI objects rather than Zod schemas, so zod-openapi adds no validators: the handlers check them in the order
// of docs/api.md, a malformed id stays a 404 and the body is stored byte-for-byte.

/**
 * A Bin's content: any JSON object or array. Only responses use it as a Zod schema, which zod-openapi never
 * validates; request bodies point at it with a plain `$ref`, so no validator is added.
 */
export const BinContent = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).openapi("BinContent", {
  description: "The JSON to store: any object or array, empty included. It is stored and returned byte-for-byte.",
  example: { theme: "dark", tags: ["a", "b"] },
});

export type BinContent = z.infer<typeof BinContent>;

const binContentRef = { $ref: "#/components/schemas/BinContent" };

const BinId = z.string().openapi("BinId", {
  description: "21 URL-safe characters, unguessable.",
  pattern: "^[A-Za-z0-9_-]{21}$",
  example: "V1StGXR8_Z5jdHi6B-myT",
});

const BinMetadataHeaders = z.object({
  "X-Bin-Id": BinId,
  "X-Bin-Private": z.enum(["true", "false"]).openapi({ description: "Whether the Bin is a Private Bin." }),
  "X-Bin-Created-At": IsoTimestamp.openapi({ description: "When the Bin was created." }),
  "X-Bin-Updated-At": IsoTimestamp.openapi({ description: "When the Bin's content was last written." }),
  "X-Bin-Expires-At": IsoTimestamp.optional().openapi({
    description: "The Bin's Expiry. Left out when the Bin has no Expiry.",
  }),
});

const CreatedBin = z
  .object({
    id: BinId,
    writeKey: z.string().openapi({
      description: "The Write Key: replaces or deletes the Bin. Shown only once.",
      pattern: "^kj_w_",
      example: "kj_w_…",
    }),
    readKey: z.string().optional().openapi({
      description: "The Read Key, only for a Private Bin: reads it. Shown only once.",
      pattern: "^kj_r_",
      example: "kj_r_…",
    }),
    private: z.boolean(),
    createdAt: IsoTimestamp,
    expiresAt: IsoTimestamp.nullable().openapi({ description: "The Bin's Expiry, or null when it never expires." }),
  })
  .openapi("CreatedBin");

const ReplacedBin = z
  .object({
    id: BinId,
    private: z.boolean(),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
    expiresAt: IsoTimestamp.nullable().openapi({ description: "The Bin's Expiry, or null when it never expires." }),
  })
  .openapi("ReplacedBin");

const idParameter = {
  name: "id",
  in: "path" as const,
  required: true,
  description: "The Bin's id. A malformed id is answered like an unknown one: `404 not_found`.",
  schema: { type: "string" as const, pattern: "^[A-Za-z0-9_-]{21}$" },
};

const binBody = {
  required: true,
  description:
    "Sent with `Content-Type: application/json` (anything else → `415`). At most the Instance's `MAX_BIN_BYTES`.",
  content: { "application/json": { schema: binContentRef } },
};

export const createBinRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Bins"],
  summary: "Create a Bin",
  description:
    "Stores the body as a new Bin and returns its keys, which are shown only once. Checks run in this order: rate " +
    "limit, `X-Bin-TTL`, content type, size, JSON, top-level type.",
  parameters: [
    {
      name: "X-Bin-Private",
      in: "header",
      required: false,
      description:
        "`true` (any case, surrounding whitespace ignored) makes a Private Bin and issues a Read Key. Any other value " +
        "makes a public Bin. Fixed at creation.",
      schema: { type: "string", example: "true" },
    },
    {
      name: "X-Bin-TTL",
      in: "header",
      required: false,
      description:
        "Seconds until the Bin's Expiry: ASCII digits only, not 0, and at most the Instance's maximum TTL (else " +
        "`400 invalid_ttl`). Without it, the Instance's default TTL applies, otherwise its maximum, otherwise none.",
      schema: { type: "integer", minimum: 1, example: 3600 },
    },
  ],
  request: { body: binBody },
  responses: {
    201: {
      description: "The Bin was created. `Location` is its URL.",
      headers: BinMetadataHeaders.extend({
        Location: z.string().openapi({ description: "The new Bin's path.", example: "/bins/V1StGXR8_Z5jdHi6B-myT" }),
      }),
      content: { "application/json": { schema: CreatedBin } },
    },
    ...errorResponses(
      "invalid_json",
      "invalid_ttl",
      "payload_too_large",
      "unsupported_media_type",
      "invalid_top_level",
      "rate_limited",
      "internal_error",
    ),
  },
});

export const readBinRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Bins"],
  summary: "Read a Bin",
  description:
    "Returns the stored JSON byte-for-byte as last written. A public Bin needs no key and ignores `Authorization`. " +
    "A Private Bin needs its Read Key or Write Key.",
  parameters: [idParameter],
  security: OPTIONAL_BEARER_AUTH,
  responses: {
    200: {
      description: "The Bin's content, sent as `application/json; charset=utf-8`.",
      headers: BinMetadataHeaders,
      content: { "application/json": { schema: BinContent } },
    },
    ...errorResponses("unauthorized", "forbidden", "not_found", "internal_error"),
  },
});

export const replaceBinRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Bins"],
  summary: "Replace a Bin's content",
  description:
    "Needs the Write Key. Body rules are the same as for creating a Bin, and last write wins. Privacy and Expiry " +
    "don't change: `X-Bin-Private` and `X-Bin-TTL` are ignored. Checks run in this order: rate limit, id, key, " +
    "content type, size, JSON, top-level type.",
  parameters: [idParameter],
  security: REQUIRED_BEARER_AUTH,
  request: { body: binBody },
  responses: {
    200: {
      description: "The content was replaced.",
      headers: BinMetadataHeaders,
      content: { "application/json": { schema: ReplacedBin } },
    },
    ...errorResponses(
      "invalid_json",
      "unauthorized",
      "forbidden",
      "not_found",
      "payload_too_large",
      "unsupported_media_type",
      "invalid_top_level",
      "rate_limited",
      "internal_error",
    ),
  },
});

export const deleteBinRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Bins"],
  summary: "Delete a Bin",
  description: "Needs the Write Key. The Bin is gone immediately and permanently.",
  parameters: [idParameter],
  security: REQUIRED_BEARER_AUTH,
  responses: {
    204: { description: "The Bin was deleted." },
    ...errorResponses("unauthorized", "forbidden", "not_found", "rate_limited", "internal_error"),
  },
});
