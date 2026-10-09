import { OpenAPIHono } from "@hono/zod-openapi";
import { type AppEnv, withConfig } from "../context";
import { ApiError } from "../errors";
import { requireKey } from "./auth";
import { parseBinBody } from "./body";
import { generateBinId, generateReadKey, generateWriteKey, hashKey, isValidBinId } from "./keys";
import { binMetadataHeaders, toIso } from "./metadata";
import { type Bin, findLive, insert, remove, replaceContent } from "./repository";

export const binRoutes = new OpenAPIHono<AppEnv>();

binRoutes.use(withConfig);

binRoutes.post("/", async (c) => {
  const content = await parseBinBody(c.req.raw, c.var.config);

  const now = Date.now();
  const writeKey = generateWriteKey();
  const isPrivate = isPrivateHeader(c.req.header("X-Bin-Private"));
  const readKey = isPrivate ? generateReadKey() : null;
  const bin: Bin = {
    id: generateBinId(),
    content,
    isPrivate,
    writeKeyHash: await hashKey(writeKey),
    readKeyHash: readKey === null ? null : await hashKey(readKey),
    // Expiry (TODO §7) is not implemented yet.
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
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

binRoutes.get("/:id", async (c) => {
  const bin = await findLiveBin(c.env.DB, c.req.param("id"), Date.now());
  await requireKey(c, bin, "read");

  return c.body(bin.content, 200, {
    "Content-Type": "application/json; charset=utf-8",
    ...binMetadataHeaders(bin),
  });
});

binRoutes.put("/:id", async (c) => {
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

binRoutes.delete("/:id", async (c) => {
  const bin = await findLiveBin(c.env.DB, c.req.param("id"), Date.now());
  await requireKey(c, bin, "write");

  // Another request can delete the Bin between the lookup and this call; that is a 404 like any other.
  if (!(await remove(c.env.DB, bin.id))) throw new ApiError(404, "not_found", "Bin not found");

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
