import type { Context } from "hono";
import { ApiError } from "../errors";
import { matches } from "./keys";
import type { Bin } from "./repository";

/**
 * What a request wants to do with a Bin. "read" is granted by the Read Key or the Write Key, and needs no key at
 * all on a public Bin. "write" (replace or delete) is granted only by the Write Key.
 */
export type Access = "read" | "write";

/**
 * The key in `Authorization: Bearer <key>`, or null when there is none: a missing header, a scheme other than
 * Bearer (matched in any case) and an empty key all count as no key.
 */
export function bearerKey(authorization: string | undefined | null): string | null {
  const match = authorization?.trim().match(/^bearer(?:\s+(.*))?$/i);
  const key = match?.[1]?.trim();
  return key ? key : null;
}

/**
 * Throws unless the request may have `access` to `bin`: `401 unauthorized` when a key is needed and none was sent,
 * `403 forbidden` when the key sent doesn't grant it. Call it after the Bin was found, so an unknown id is a 404
 * before auth is considered (docs/api.md → Validation and errors). Keys are compared in constant time and are never
 * logged or put in an error message.
 */
export async function requireKey(c: Context, bin: Bin, access: Access): Promise<void> {
  // A public Bin can be read by anyone, so its Authorization header is ignored, even a malformed one.
  if (access === "read" && !bin.isPrivate) return;

  const key = bearerKey(c.req.header("Authorization"));
  if (key === null) throw new ApiError(401, "unauthorized", "This Bin needs a key: send Authorization: Bearer <key>");

  if (!(await grants(key, bin, access))) throw new ApiError(403, "forbidden", "The key sent doesn't grant this");
}

async function grants(key: string, bin: Bin, access: Access): Promise<boolean> {
  if (await matches(key, bin.writeKeyHash)) return true;
  return access === "read" && bin.readKeyHash !== null && (await matches(key, bin.readKeyHash));
}
