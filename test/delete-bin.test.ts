import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateBinId, generateReadKey, generateWriteKey, hashKey } from "../src/bins/keys";
import { type Bin, findLive, insert } from "../src/bins/repository";

const BASE_URL = "https://keepjson.test";

type StoredBin = { bin: Bin; writeKey: string; readKey: string | null };

/** Inserts a Bin through the repository, returning its plaintext keys. */
async function storeBin(options: { isPrivate?: boolean; expiresAt?: number | null } = {}): Promise<StoredBin> {
  const writeKey = generateWriteKey();
  const readKey = options.isPrivate ? generateReadKey() : null;
  const now = Date.now();
  const bin: Bin = {
    id: generateBinId(),
    content: '{"keep": true}',
    isPrivate: options.isPrivate ?? false,
    writeKeyHash: await hashKey(writeKey),
    readKeyHash: readKey === null ? null : await hashKey(readKey),
    createdAt: now,
    updatedAt: now,
    expiresAt: options.expiresAt ?? null,
  };
  await insert(env.DB, bin);
  return { bin, writeKey, readKey };
}

function deleteBin(id: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${BASE_URL}/bins/${id}`, { method: "DELETE", headers });
}

function getBin(id: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${BASE_URL}/bins/${id}`, { headers });
}

function putBin(id: string, body: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${BASE_URL}/bins/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function bearer(key: string | null): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.has("X-Bin-Id")).toBe(false);
  expect(await res.json()).toEqual({ error: { code, message: expect.any(String) } });
}

async function expectStillThere(stored: StoredBin) {
  expect(await findLive(env.DB, stored.bin.id, Date.now())).toEqual(stored.bin);
}

async function expectGone(id: string) {
  // At time 0 no stored Expiry has passed, so findLive returns the row if it is still in D1 at all.
  expect(await findLive(env.DB, id, 0)).toBeNull();
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM bins");
});

describe("DELETE /bins/:id", () => {
  it("deletes a Bin with its Write Key and responds 204 with an empty body", async () => {
    const stored = await storeBin();

    const res = await deleteBin(stored.bin.id, bearer(stored.writeKey));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.has("X-Bin-Id")).toBe(false);

    await expectGone(stored.bin.id);
  });

  it("makes the Bin gone immediately: a later GET and a later PUT get 404", async () => {
    const stored = await storeBin();
    expect((await deleteBin(stored.bin.id, bearer(stored.writeKey))).status).toBe(204);

    await expectError(await getBin(stored.bin.id), 404, "not_found");
    await expectError(await putBin(stored.bin.id, "{}", bearer(stored.writeKey)), 404, "not_found");
    await expectGone(stored.bin.id);
  });

  it("deletes a Private Bin with its Write Key", async () => {
    const stored = await storeBin({ isPrivate: true });

    expect((await deleteBin(stored.bin.id, bearer(stored.writeKey))).status).toBe(204);
    await expectError(await getBin(stored.bin.id, bearer(stored.readKey)), 404, "not_found");
    await expectGone(stored.bin.id);
  });

  it("returns 404 when the Bin is deleted twice", async () => {
    const stored = await storeBin();

    expect((await deleteBin(stored.bin.id, bearer(stored.writeKey))).status).toBe(204);
    await expectError(await deleteBin(stored.bin.id, bearer(stored.writeKey)), 404, "not_found");
  });

  it("leaves other Bins untouched", async () => {
    const target = await storeBin();
    const others = [await storeBin(), await storeBin({ isPrivate: true })];

    expect((await deleteBin(target.bin.id, bearer(target.writeKey))).status).toBe(204);

    await expectGone(target.bin.id);
    for (const other of others) await expectStillThere(other);
  });

  it("accepts the scheme in any case", async () => {
    const stored = await storeBin();
    expect((await deleteBin(stored.bin.id, { Authorization: `bearer ${stored.writeKey}` })).status).toBe(204);
  });

  describe("auth", () => {
    it("rejects the Read Key of a Private Bin with 403", async () => {
      const stored = await storeBin({ isPrivate: true });
      await expectError(await deleteBin(stored.bin.id, bearer(stored.readKey)), 403, "forbidden");
      await expectStillThere(stored);
    });

    it.each([
      ["a random string", () => "Bearer not-a-key"],
      ["a made-up Write Key", () => `Bearer ${generateWriteKey()}`],
      ["a made-up Read Key", () => `Bearer ${generateReadKey()}`],
    ])("rejects %s with 403, on a Private Bin and on a public Bin", async (_name, authorization) => {
      for (const isPrivate of [true, false]) {
        const stored = await storeBin({ isPrivate });
        await expectError(await deleteBin(stored.bin.id, { Authorization: authorization() }), 403, "forbidden");
        await expectStillThere(stored);
      }
    });

    it("rejects the Write Key of a different Bin with 403", async () => {
      const mine = await storeBin();
      const other = await storeBin();
      await expectError(await deleteBin(mine.bin.id, bearer(other.writeKey)), 403, "forbidden");
      await expectStillThere(mine);
      await expectStillThere(other);
    });

    it.each([
      ["no Authorization header", {}],
      ["a non-Bearer scheme", { Authorization: "Basic dXNlcjpwYXNz" }],
      ["an empty Bearer key", { Authorization: "Bearer " }],
    ])("rejects %s with 401, on a Private Bin and on a public Bin", async (_name, headers) => {
      for (const isPrivate of [true, false]) {
        const stored = await storeBin({ isPrivate });
        await expectError(await deleteBin(stored.bin.id, headers), 401, "unauthorized");
        await expectStillThere(stored);
      }
    });

    it("never sends a key back", async () => {
      const stored = await storeBin({ isPrivate: true });
      for (const headers of [bearer(stored.readKey), {}, bearer(stored.writeKey)]) {
        const res = await deleteBin(stored.bin.id, headers);
        const text = await res.text();
        for (const key of [stored.writeKey, stored.readKey ?? ""]) {
          expect(text).not.toContain(key);
          for (const [, value] of res.headers) expect(value).not.toContain(key);
        }
      }
    });
  });

  describe("not found", () => {
    it("returns 404 for an unknown id", async () => {
      await expectError(await deleteBin(generateBinId(), bearer(generateWriteKey())), 404, "not_found");
    });

    it.each([
      ["too short", "V1StGXR8_Z5jdHi6B-my"],
      ["too long", "V1StGXR8_Z5jdHi6B-myTx"],
      ["a bad character", "V1StGXR8_Z5jdHi6B-my!"],
    ])("returns 404 for an id that is %s", async (_name, id) => {
      await expectError(await deleteBin(id, bearer(generateWriteKey())), 404, "not_found");
    });

    it("returns 404 for an expired Bin, even with its Write Key", async () => {
      const stored = await storeBin({ expiresAt: Date.now() - 1000 });
      await expectError(await deleteBin(stored.bin.id, bearer(stored.writeKey)), 404, "not_found");
    });

    it("checks the id before auth", async () => {
      const expired = await storeBin({ isPrivate: true, expiresAt: Date.now() - 1000 });
      await expectError(await deleteBin(expired.bin.id), 404, "not_found");
      await expectError(await deleteBin(expired.bin.id, bearer(expired.readKey)), 404, "not_found");
      await expectError(await deleteBin(generateBinId()), 404, "not_found");
      await expectError(await deleteBin("malformed", bearer("not-a-key")), 404, "not_found");
    });
  });
});
