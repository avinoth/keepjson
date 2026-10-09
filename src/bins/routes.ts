import { OpenAPIHono } from "@hono/zod-openapi";
import { type AppEnv, withConfig } from "../context";
import { parseBinBody } from "./body";
import { generateBinId, generateWriteKey, hashKey } from "./keys";
import { binMetadataHeaders, toIso } from "./metadata";
import { type Bin, insert } from "./repository";

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
