import { OpenAPIHono } from "@hono/zod-openapi";
import { type AppEnv, withConfig } from "../context";
import { ApiError } from "../errors";
import { parseBinBody } from "./body";
import { generateBinId, generateWriteKey, hashKey, isValidBinId } from "./keys";
import { binMetadataHeaders, toIso } from "./metadata";
import { type Bin, findLive, insert } from "./repository";

export const binRoutes = new OpenAPIHono<AppEnv>();

binRoutes.use(withConfig);

binRoutes.post("/", async (c) => {
  const content = await parseBinBody(c.req.raw, c.var.config);

  const now = Date.now();
  const writeKey = generateWriteKey();
  const bin: Bin = {
    id: generateBinId(),
    content,
    // Private Bins (TODO §4) and Expiry (TODO §7) are not implemented yet.
    isPrivate: false,
    writeKeyHash: await hashKey(writeKey),
    readKeyHash: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
  };
  await insert(c.env.DB, bin);

  return c.json(
    {
      id: bin.id,
      writeKey,
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
  // Private Bins (TODO §4) will check the Authorization header here.

  return c.body(bin.content, 200, {
    "Content-Type": "application/json; charset=utf-8",
    ...binMetadataHeaders(bin),
  });
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
