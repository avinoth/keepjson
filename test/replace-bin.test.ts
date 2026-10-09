import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateBinId, generateReadKey, generateWriteKey, hashKey } from "../src/bins/keys";
import { type Bin, findLive, insert } from "../src/bins/repository";
import { parseConfig } from "../src/config";

const BASE_URL = "https://keepjson.test";
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const { maxBinBytes } = parseConfig(env);

// A Bin created and last replaced long ago, so a replace observably moves `updatedAt` forward.
const CREATED_AT = Date.parse("2026-01-01T00:00:00.000Z");
const UPDATED_AT = Date.parse("2026-02-01T00:00:00.000Z");

type ReplacedBin = { id: string; private: boolean; createdAt: string; updatedAt: string; expiresAt: string | null };

type StoredBin = { bin: Bin; writeKey: string; readKey: string | null };

/** Inserts a Bin through the repository, returning its plaintext keys. */
async function storeBin(
  options: { content?: string; isPrivate?: boolean; expiresAt?: number | null } = {},
): Promise<StoredBin> {
  const writeKey = generateWriteKey();
  const readKey = options.isPrivate ? generateReadKey() : null;
  const bin: Bin = {
    id: generateBinId(),
    content: options.content ?? '{"old": true}',
    isPrivate: options.isPrivate ?? false,
    writeKeyHash: await hashKey(writeKey),
    readKeyHash: readKey === null ? null : await hashKey(readKey),
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    expiresAt: options.expiresAt ?? null,
  };
  await insert(env.DB, bin);
  return { bin, writeKey, readKey };
}

function putBin(
  id: string,
  body: BodyInit | null,
  headers: Record<string, string> = {},
  contentType: string | null = "application/json",
) {
  return exports.default.fetch(`${BASE_URL}/bins/${id}`, {
    method: "PUT",
    headers: { ...(contentType === null ? {} : { "Content-Type": contentType }), ...headers },
    body,
  });
}

function bearer(key: string | null): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

function getBin(id: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${BASE_URL}/bins/${id}`, { headers });
}

/** A JSON array of exactly `byteCount` bytes. */
function jsonArrayOfBytes(byteCount: number): string {
  return `["${"a".repeat(byteCount - 4)}"]`;
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.has("X-Bin-Id")).toBe(false);
  expect(await res.json()).toEqual({ error: { code, message: expect.any(String) } });
}

async function expectUnchanged(stored: StoredBin) {
  expect(await findLive(env.DB, stored.bin.id, Date.now())).toEqual(stored.bin);
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM bins");
});

describe("PUT /bins/:id", () => {
  it.each([
    ["an object", '{ "new" : [1, 2],\n  "a": "é ✓ 🎉" }'],
    ["an array", '\n [ 3, {"z": null, "a": "\\u00e9"} ]  \n'],
    ["an empty object", "{}"],
    ["an empty array", "[]"],
  ])("replaces the content with %s, which a later GET returns byte-for-byte", async (_name, content) => {
    const stored = await storeBin();

    const res = await putBin(stored.bin.id, content, bearer(stored.writeKey));
    expect(res.status).toBe(200);

    const read = await getBin(stored.bin.id);
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(new TextEncoder().encode(content));
  });

  it("returns the metadata body", async () => {
    const stored = await storeBin();
    const before = Date.now();

    const res = await putBin(stored.bin.id, '{"a": 1}', bearer(stored.writeKey));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);

    const body = (await res.json()) as ReplacedBin;
    expect(Object.keys(body).sort()).toEqual(["createdAt", "expiresAt", "id", "private", "updatedAt"]);
    expect(body.id).toBe(stored.bin.id);
    expect(body.private).toBe(false);
    expect(body.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(body.updatedAt).toMatch(ISO_UTC);
    expect(Date.parse(body.updatedAt)).toBeGreaterThanOrEqual(before);
    expect(body.expiresAt).toBeNull();
  });

  it("sends the metadata headers and Cache-Control", async () => {
    const stored = await storeBin();

    const res = await putBin(stored.bin.id, '{"a": 1}', bearer(stored.writeKey));
    const body = (await res.json()) as ReplacedBin;

    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Bin-Id")).toBe(stored.bin.id);
    expect(res.headers.get("X-Bin-Private")).toBe("false");
    expect(res.headers.get("X-Bin-Created-At")).toBe(body.createdAt);
    expect(res.headers.get("X-Bin-Updated-At")).toBe(body.updatedAt);
    expect(res.headers.has("X-Bin-Expires-At")).toBe(false);
    expect(res.headers.has("Location")).toBe(false);
  });

  it("moves updatedAt forward and keeps createdAt, privacy, Expiry and the keys", async () => {
    const expiresAt = Date.now() + 3_600_000;
    const stored = await storeBin({ isPrivate: true, expiresAt });
    const before = Date.now();

    const res = await putBin(stored.bin.id, '{"new": 1}', bearer(stored.writeKey));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReplacedBin;
    expect(body.private).toBe(true);
    expect(body.createdAt).toBe(new Date(CREATED_AT).toISOString());
    expect(body.expiresAt).toBe(new Date(expiresAt).toISOString());
    expect(res.headers.get("X-Bin-Expires-At")).toBe(body.expiresAt);
    expect(res.headers.get("X-Bin-Private")).toBe("true");

    const after = await findLive(env.DB, stored.bin.id, Date.now());
    expect(after).toEqual({ ...stored.bin, content: '{"new": 1}', updatedAt: Date.parse(body.updatedAt) });
    expect(after?.updatedAt).toBeGreaterThan(UPDATED_AT);
    expect(after?.updatedAt).toBeGreaterThanOrEqual(before);

    const read = await getBin(stored.bin.id, bearer(stored.readKey));
    expect(read.headers.get("X-Bin-Updated-At")).toBe(body.updatedAt);
    expect(read.headers.get("X-Bin-Created-At")).toBe(body.createdAt);
  });

  it("never sends a key back", async () => {
    const stored = await storeBin({ isPrivate: true });

    const res = await putBin(stored.bin.id, "{}", bearer(stored.writeKey));
    const text = await res.text();
    for (const key of [stored.writeKey, stored.readKey ?? ""]) {
      expect(text).not.toContain(key);
      for (const [, value] of res.headers) expect(value).not.toContain(key);
    }
  });

  it("lets the last write win", async () => {
    const stored = await storeBin();
    await putBin(stored.bin.id, '{"n": 1}', bearer(stored.writeKey));
    await putBin(stored.bin.id, '{"n": 2}', bearer(stored.writeKey));
    expect(await (await getBin(stored.bin.id)).text()).toBe('{"n": 2}');
  });

  describe("auth", () => {
    it("accepts the Write Key of a Private Bin", async () => {
      const stored = await storeBin({ isPrivate: true });
      expect((await putBin(stored.bin.id, "[1]", bearer(stored.writeKey))).status).toBe(200);
    });

    it("rejects the Read Key of a Private Bin with 403", async () => {
      const stored = await storeBin({ isPrivate: true });
      await expectError(await putBin(stored.bin.id, "[1]", bearer(stored.readKey)), 403, "forbidden");
      await expectUnchanged(stored);
    });

    it.each([
      ["a random string", () => "Bearer not-a-key"],
      ["a made-up Write Key", () => `Bearer ${generateWriteKey()}`],
      ["a made-up Read Key", () => `Bearer ${generateReadKey()}`],
    ])("rejects %s with 403", async (_name, authorization) => {
      for (const isPrivate of [true, false]) {
        const stored = await storeBin({ isPrivate });
        await expectError(await putBin(stored.bin.id, "[1]", { Authorization: authorization() }), 403, "forbidden");
        await expectUnchanged(stored);
      }
    });

    it("rejects the Write Key of a different Bin with 403", async () => {
      const mine = await storeBin();
      const other = await storeBin();
      await expectError(await putBin(mine.bin.id, "[1]", bearer(other.writeKey)), 403, "forbidden");
      await expectUnchanged(mine);
    });

    it.each([
      ["no Authorization header", {}],
      ["a non-Bearer scheme", { Authorization: "Basic dXNlcjpwYXNz" }],
      ["an empty Bearer key", { Authorization: "Bearer " }],
    ])("rejects %s with 401, on a Private Bin and on a public Bin", async (_name, headers) => {
      for (const isPrivate of [true, false]) {
        const stored = await storeBin({ isPrivate });
        await expectError(await putBin(stored.bin.id, "[1]", headers), 401, "unauthorized");
        await expectUnchanged(stored);
      }
    });

    it("accepts the scheme in any case", async () => {
      const stored = await storeBin();
      expect((await putBin(stored.bin.id, "[1]", { Authorization: `bearer ${stored.writeKey}` })).status).toBe(200);
    });
  });

  describe("not found", () => {
    it("returns 404 for an unknown id", async () => {
      await expectError(await putBin(generateBinId(), "{}", bearer(generateWriteKey())), 404, "not_found");
    });

    it.each([
      ["too short", "V1StGXR8_Z5jdHi6B-my"],
      ["too long", "V1StGXR8_Z5jdHi6B-myTx"],
      ["a bad character", "V1StGXR8_Z5jdHi6B-my!"],
    ])("returns 404 for an id that is %s", async (_name, id) => {
      await expectError(await putBin(id, "{}", bearer(generateWriteKey())), 404, "not_found");
    });

    it("returns 404 for an expired Bin, even with its Write Key", async () => {
      const stored = await storeBin({ expiresAt: Date.now() - 1000 });
      await expectError(await putBin(stored.bin.id, "{}", bearer(stored.writeKey)), 404, "not_found");
    });

    it("checks the id before auth and the body", async () => {
      await expectError(await putBin(generateBinId(), '"str"', {}, "text/plain"), 404, "not_found");
      await expectError(await putBin("malformed", "{", {}), 404, "not_found");
    });
  });

  describe("auth before body validation", () => {
    it("returns 401 for no key with invalid JSON", async () => {
      const stored = await storeBin();
      await expectError(await putBin(stored.bin.id, "{", {}), 401, "unauthorized");
    });

    it("returns 403 for a wrong key with a wrong content type", async () => {
      const stored = await storeBin();
      await expectError(await putBin(stored.bin.id, "{}", bearer(generateWriteKey()), "text/plain"), 403, "forbidden");
    });

    it("returns 403 for the Read Key with a body over the limit", async () => {
      const stored = await storeBin({ isPrivate: true });
      const res = await putBin(stored.bin.id, jsonArrayOfBytes(maxBinBytes + 1), bearer(stored.readKey));
      await expectError(res, 403, "forbidden");
    });

    it("doesn't read the body before auth passes", async () => {
      const stored = await storeBin();
      // The stream never ends, so the request would hang if the body were read.
      const neverEnds = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
      await expectError(await putBin(stored.bin.id, neverEnds, {}), 401, "unauthorized");
    });
  });

  describe("body validation", () => {
    it("rejects a missing Content-Type with 415", async () => {
      const stored = await storeBin();
      await expectError(
        await putBin(stored.bin.id, "{}", bearer(stored.writeKey), null),
        415,
        "unsupported_media_type",
      );
      await expectUnchanged(stored);
    });

    it("rejects a non-JSON Content-Type with 415", async () => {
      const stored = await storeBin();
      const res = await putBin(stored.bin.id, "{}", bearer(stored.writeKey), "text/plain");
      await expectError(res, 415, "unsupported_media_type");
    });

    it.each(["", "{", '{"a": 1,}', "[1, 2"])("rejects invalid JSON %j with 400", async (content) => {
      const stored = await storeBin();
      await expectError(await putBin(stored.bin.id, content, bearer(stored.writeKey)), 400, "invalid_json");
      await expectUnchanged(stored);
    });

    it.each(['"str"', "1", "null", "true"])("rejects top-level %s with 422", async (content) => {
      const stored = await storeBin();
      await expectError(await putBin(stored.bin.id, content, bearer(stored.writeKey)), 422, "invalid_top_level");
      await expectUnchanged(stored);
    });

    it("accepts a body of exactly MAX_BIN_BYTES", async () => {
      const stored = await storeBin();
      const content = jsonArrayOfBytes(maxBinBytes);
      expect((await putBin(stored.bin.id, content, bearer(stored.writeKey))).status).toBe(200);
      expect((await findLive(env.DB, stored.bin.id, Date.now()))?.content).toBe(content);
    });

    it("rejects a body one byte over MAX_BIN_BYTES with 413", async () => {
      const stored = await storeBin();
      const res = await putBin(stored.bin.id, jsonArrayOfBytes(maxBinBytes + 1), bearer(stored.writeKey));
      await expectError(res, 413, "payload_too_large");
      await expectUnchanged(stored);
    });

    it("checks the content type before the size, and the size before parsing", async () => {
      const stored = await storeBin();
      const tooLarge = `[${"x".repeat(maxBinBytes)}`;
      await expectError(
        await putBin(stored.bin.id, tooLarge, bearer(stored.writeKey), "text/plain"),
        415,
        "unsupported_media_type",
      );
      await expectError(await putBin(stored.bin.id, tooLarge, bearer(stored.writeKey)), 413, "payload_too_large");
    });
  });

  describe("ignored headers", () => {
    it("keeps a public Bin public when X-Bin-Private: true is sent", async () => {
      const stored = await storeBin();

      const res = await putBin(stored.bin.id, '{"a": 1}', { ...bearer(stored.writeKey), "X-Bin-Private": "true" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ReplacedBin;
      expect(body.private).toBe(false);
      expect(body).not.toHaveProperty("readKey");
      expect(res.headers.get("X-Bin-Private")).toBe("false");

      const after = await findLive(env.DB, stored.bin.id, Date.now());
      expect(after?.isPrivate).toBe(false);
      expect(after?.readKeyHash).toBeNull();
      const read = await getBin(stored.bin.id);
      expect(read.status).toBe(200);
      expect(await read.text()).toBe('{"a": 1}');
    });

    it("keeps a Private Bin private when X-Bin-Private: false is sent", async () => {
      const stored = await storeBin({ isPrivate: true });

      const res = await putBin(stored.bin.id, '{"a": 1}', { ...bearer(stored.writeKey), "X-Bin-Private": "false" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as ReplacedBin).private).toBe(true);

      const after = await findLive(env.DB, stored.bin.id, Date.now());
      expect(after?.isPrivate).toBe(true);
      expect(after?.readKeyHash).toBe(stored.bin.readKeyHash);
      await expectError(await getBin(stored.bin.id), 401, "unauthorized");
      const read = await getBin(stored.bin.id, bearer(stored.readKey));
      expect(read.status).toBe(200);
      expect(await read.text()).toBe('{"a": 1}');
    });

    it("doesn't set an Expiry from X-Bin-TTL", async () => {
      const stored = await storeBin();

      const res = await putBin(stored.bin.id, "{}", { ...bearer(stored.writeKey), "X-Bin-TTL": "60" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as ReplacedBin).expiresAt).toBeNull();
      expect(res.headers.has("X-Bin-Expires-At")).toBe(false);
      expect((await findLive(env.DB, stored.bin.id, Date.now()))?.expiresAt).toBeNull();
    });

    it("doesn't change an existing Expiry from X-Bin-TTL, and ignores an invalid one", async () => {
      const expiresAt = Date.now() + 3_600_000;
      const stored = await storeBin({ expiresAt });

      for (const ttl of ["60", "not-a-number", "-1"]) {
        const res = await putBin(stored.bin.id, "{}", { ...bearer(stored.writeKey), "X-Bin-TTL": ttl });
        expect(res.status).toBe(200);
        expect(((await res.json()) as ReplacedBin).expiresAt).toBe(new Date(expiresAt).toISOString());
      }
      expect((await findLive(env.DB, stored.bin.id, Date.now()))?.expiresAt).toBe(expiresAt);
    });
  });
});
