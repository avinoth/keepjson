import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateBinId, generateWriteKey, hashKey } from "../src/bins/keys";
import { MISSING_IP_KEY, RATE_LIMIT_PERIOD_SECONDS } from "../src/bins/rate-limit";
import { type Bin, findLive, insert } from "../src/bins/repository";
import { app } from "../src/index";

const BASE_URL = "https://keepjson.test";
const CLIENT_IP = "203.0.113.7";

/** A limiter binding that allows or denies every call and remembers the keys it was called with. */
type StubLimiter = RateLimit & { keys: string[] };

function stubLimiter(success: boolean): StubLimiter {
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      return { success };
    },
  };
}

type Limiters = { create: StubLimiter; write: StubLimiter };

function limiters(success: boolean): Limiters {
  return { create: stubLimiter(success), write: stubLimiter(success) };
}

/**
 * Calls the app directly, so the limiter bindings can be stubs and rate limiting can be turned on: the test worker
 * itself runs with RATE_LIMIT_ENABLED=false (vitest.config.ts).
 */
async function send(
  stubs: Limiters,
  path: string,
  init: RequestInit = {},
  options: { enabled?: boolean; ip?: string | null } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const ip = options.ip === undefined ? CLIENT_IP : options.ip;
  if (ip !== null) headers.set("CF-Connecting-IP", ip);
  const testEnv: Env = {
    ...env,
    RATE_LIMIT_ENABLED: String(options.enabled ?? true),
    CREATE_LIMITER: stubs.create,
    WRITE_LIMITER: stubs.write,
  };
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers }), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function postBin(stubs: Limiters, body = '{"keep": true}', options?: { enabled?: boolean; ip?: string | null }) {
  return send(stubs, "/bins", { method: "POST", headers: { "Content-Type": "application/json" }, body }, options);
}

function putBin(stubs: Limiters, id: string, writeKey: string, body = '{"replaced": true}') {
  return send(stubs, `/bins/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
    body,
  });
}

function deleteBin(stubs: Limiters, id: string, writeKey: string) {
  return send(stubs, `/bins/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${writeKey}` } });
}

/** Inserts a public Bin through the repository, returning it with its plaintext Write Key. */
async function storeBin(): Promise<{ bin: Bin; writeKey: string }> {
  const writeKey = generateWriteKey();
  const now = Date.now();
  const bin: Bin = {
    id: generateBinId(),
    content: '{"keep": true}',
    isPrivate: false,
    writeKeyHash: await hashKey(writeKey),
    readKeyHash: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
  };
  await insert(env.DB, bin);
  return { bin, writeKey };
}

async function countBins(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM bins").first<{ n: number }>();
  return row?.n ?? 0;
}

async function expectRateLimited(res: Response) {
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe(String(RATE_LIMIT_PERIOD_SECONDS));
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.has("X-Bin-Id")).toBe(false);
  expect(await res.json()).toEqual({ error: { code: "rate_limited", message: expect.any(String) } });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM bins");
});

describe("the test worker", () => {
  it("runs with rate limiting turned off, so other test files can create many Bins", () => {
    expect(env.RATE_LIMIT_ENABLED).toBe("false");
  });
});

describe("rate limiting", () => {
  it("sends the Retry-After period of the limiter bindings in wrangler.jsonc", () => {
    expect(RATE_LIMIT_PERIOD_SECONDS).toBe(60);
  });

  describe("under the limit", () => {
    it("creates a Bin, checking CREATE_LIMITER with the client's IP", async () => {
      const stubs = limiters(true);
      const res = await postBin(stubs);
      expect(res.status).toBe(201);
      expect(stubs.create.keys).toEqual([CLIENT_IP]);
      expect(stubs.write.keys).toEqual([]);
      expect(await countBins()).toBe(1);
    });

    it("replaces a Bin, checking WRITE_LIMITER with the client's IP", async () => {
      const stubs = limiters(true);
      const { bin, writeKey } = await storeBin();
      const res = await putBin(stubs, bin.id, writeKey);
      expect(res.status).toBe(200);
      expect(stubs.write.keys).toEqual([CLIENT_IP]);
      expect(stubs.create.keys).toEqual([]);
      expect((await findLive(env.DB, bin.id, Date.now()))?.content).toBe('{"replaced": true}');
    });

    it("deletes a Bin, checking WRITE_LIMITER with the client's IP", async () => {
      const stubs = limiters(true);
      const { bin, writeKey } = await storeBin();
      const res = await deleteBin(stubs, bin.id, writeKey);
      expect(res.status).toBe(204);
      expect(stubs.write.keys).toEqual([CLIENT_IP]);
      expect(stubs.create.keys).toEqual([]);
      expect(await findLive(env.DB, bin.id, 0)).toBeNull();
    });

    it("uses one shared fallback key when CF-Connecting-IP is missing", async () => {
      const stubs = limiters(true);
      const res = await postBin(stubs, "{}", { ip: null });
      expect(res.status).toBe(201);
      expect(stubs.create.keys).toEqual([MISSING_IP_KEY]);
    });
  });

  describe("over the limit", () => {
    it("rejects POST /bins with 429 rate_limited and creates nothing", async () => {
      const stubs = limiters(false);
      await expectRateLimited(await postBin(stubs));
      expect(stubs.create.keys).toEqual([CLIENT_IP]);
      expect(await countBins()).toBe(0);
    });

    it("rejects PUT /bins/:id with 429 rate_limited and leaves the Bin unchanged", async () => {
      const stubs = limiters(false);
      const { bin, writeKey } = await storeBin();
      await expectRateLimited(await putBin(stubs, bin.id, writeKey));
      expect(stubs.write.keys).toEqual([CLIENT_IP]);
      expect(await findLive(env.DB, bin.id, Date.now())).toEqual(bin);
    });

    it("rejects DELETE /bins/:id with 429 rate_limited and keeps the Bin", async () => {
      const stubs = limiters(false);
      const { bin, writeKey } = await storeBin();
      await expectRateLimited(await deleteBin(stubs, bin.id, writeKey));
      expect(stubs.write.keys).toEqual([CLIENT_IP]);
      expect(await findLive(env.DB, bin.id, Date.now())).toEqual(bin);
    });

    it("checks the limit before the body is validated", async () => {
      const stubs = limiters(false);
      await expectRateLimited(await postBin(stubs, "not json"));
      await expectRateLimited(
        await send(stubs, "/bins", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }),
      );
      await expectRateLimited(
        await send(stubs, "/bins", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Bin-TTL": "-1" },
          body: "{}",
        }),
      );
    });

    it("checks the limit before the id and the Write Key", async () => {
      const stubs = limiters(false);
      const { bin } = await storeBin();
      await expectRateLimited(await putBin(stubs, generateBinId(), generateWriteKey()));
      await expectRateLimited(await deleteBin(stubs, "not-an-id", generateWriteKey()));
      await expectRateLimited(await send(stubs, `/bins/${bin.id}`, { method: "DELETE" }));
      expect(await countBins()).toBe(1);
    });

    it("never limits GET /bins/:id or GET /health", async () => {
      const stubs = limiters(false);
      const { bin } = await storeBin();
      expect((await send(stubs, `/bins/${bin.id}`)).status).toBe(200);
      expect((await send(stubs, `/bins/${generateBinId()}`)).status).toBe(404);
      expect((await send(stubs, "/health")).status).toBe(200);
      expect(stubs.create.keys).toEqual([]);
      expect(stubs.write.keys).toEqual([]);
    });
  });

  describe("with RATE_LIMIT_ENABLED=false", () => {
    it("never calls a limiter, even one that would deny", async () => {
      const stubs = limiters(false);
      expect((await postBin(stubs, "{}", { enabled: false })).status).toBe(201);
      const { bin, writeKey } = await storeBin();
      const put = await send(
        stubs,
        `/bins/${bin.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
          body: "[]",
        },
        { enabled: false },
      );
      expect(put.status).toBe(200);
      const del = await send(
        stubs,
        `/bins/${bin.id}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${writeKey}` } },
        { enabled: false },
      );
      expect(del.status).toBe(204);
      expect(stubs.create.keys).toEqual([]);
      expect(stubs.write.keys).toEqual([]);
    });
  });
});
