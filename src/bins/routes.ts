import { OpenAPIHono } from "@hono/zod-openapi";
import type { TypedResponse } from "hono";
import type { AppEnv } from "../context";
import { ApiError } from "../errors";
import { requireKey } from "./auth";
import { parseBinBody } from "./body";
import { resolveExpiresAt } from "./expiry";
import { generateBinId, generateReadKey, generateWriteKey, hashKey, isValidBinId } from "./keys";
import { binMetadataHeaders, toIso } from "./metadata";
import { type Bin, findLive, insert, remove, replaceContent } from "./repository";
import { type BinContent, createBinRoute, deleteBinRoute, readBinRoute, replaceBinRoute } from "./spec";

export const binRoutes = new OpenAPIHono<AppEnv>();

binRoutes.openapi(createBinRoute, async (c) => {
  const now = Date.now();
  // X-Bin-TTL is checked before the body (docs/api.md → Validation and errors): it is a header, so a bad one is
  // rejected without reading the body, and parseBinBody stays the same for PUT, which ignores X-Bin-TTL.
  const expiresAt = resolveExpiresAt(c.req.header("X-Bin-TTL"), c.var.config, now);
  const content = await parseBinBody(c.req.raw, c.var.config);

  const writeKey = generateWriteKey();
  const isPrivate = isPrivateHeader(c.req.header("X-Bin-Private"));
  const readKey = isPrivate ? generateReadKey() : null;
  const bin: Bin = {
    id: generateBinId(),
    content,
    isPrivate,
    writeKeyHash: await hashKey(writeKey),
    readKeyHash: readKey === null ? null : await hashKey(readKey),
    createdAt: now,
    updatedAt: now,
    expiresAt,
  };
  await insert(c.env.DB, bin);

  return c.json(
    {
      id: bin.id,
      writeKey,
      // Only a Private Bin has a Read Key, so a public Bin's body has no `readKey` field at all.
      ...(readKey === null ? {} : { readKey }),
      private: bin.isPrivate,
      createdAt: toIso(bin.createdAt),
      expiresAt: bin.expiresAt === null ? null : toIso(bin.expiresAt),
    },
    201,
    { Location: `/bins/${bin.id}`, ...binMetadataHeaders(bin) },
  );
});

binRoutes.openapi(readBinRoute, async (c) => {
  const bin = await findLiveBin(c.env.DB, c.req.param("id"), Date.now());
  await requireKey(c, bin, "read");

  // The stored text is sent as is, which c.json can't do: it would re-serialize it. It is the JSON the route describes.
  const res = c.body(bin.content, 200, {
    "Content-Type": "application/json; charset=utf-8",
    ...binMetadataHeaders(bin),
  });
  return res as typeof res & TypedResponse<BinContent, 200, "json">;
});

binRoutes.openapi(replaceBinRoute, async (c) => {
  const bin = await findLiveBin(c.env.DB, c.req.param("id"), Date.now());
  // Auth comes before the body is read (docs/api.md → Validation and errors).
  await requireKey(c, bin, "write");
  const content = await parseBinBody(c.req.raw, c.var.config);

  // Privacy and Expiry are fixed at creation, so X-Bin-Private and X-Bin-TTL are ignored here.
  const now = Date.now();
  // The Bin can be deleted or expire between the lookup and the update; that is a 404 like any other.
  if (!(await replaceContent(c.env.DB, bin.id, content, now))) throw new ApiError(404, "not_found", "Bin not found");
  const replaced: Bin = { ...bin, content, updatedAt: now };

  return c.json(
    {
      id: replaced.id,
      private: replaced.isPrivate,
      createdAt: toIso(replaced.createdAt),
      updatedAt: toIso(replaced.updatedAt),
      expiresAt: replaced.expiresAt === null ? null : toIso(replaced.expiresAt),
    },
    200,
    binMetadataHeaders(replaced),
  );
});

binRoutes.openapi(deleteBinRoute, async (c) => {
  const bin = await findLiveBin(c.env.DB, c.req.param("id"), Date.now());
  await requireKey(c, bin, "write");

  // The Bin can be deleted by another request or expire between the lookup and this call; that is a 404 like any other.
  if (!(await remove(c.env.DB, bin.id, Date.now()))) throw new ApiError(404, "not_found", "Bin not found");

  return c.body(null, 204);
});

/**
 * The live Bin with this id. Throws `404 not_found` for a malformed id (without asking D1), an unknown id
 * or an expired Bin, which can't be told apart.
 */
async function findLiveBin(db: D1Database, id: string, now: number): Promise<Bin> {
  const bin = isValidBinId(id) ? await findLive(db, id, now) : null;
  if (!bin) throw new ApiError(404, "not_found", "Bin not found");
  return bin;
}

/**
 * Whether `X-Bin-Private` asks for a Private Bin. Only `true` does (in any case, ignoring surrounding whitespace).
 * Any other value, including `false`, `1`, an empty value or no header, makes a public Bin rather than an error:
 * the contract defines no error for this header, and falling back to public never hides a Bin from its creator,
 * since the `private` field of the response says which kind was made.
 */
function isPrivateHeader(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}
