import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateBinId, generateWriteKey, hashKey } from "../src/bins/keys";
import { type Bin, findLive, insert } from "../src/bins/repository";
import { parseConfig } from "../src/config";

const BINS_URL = "https://keepjson.test/bins";
const NOW = 1_791_547_200_000; // 2026-10-09T12:00:00.000Z

type CreatedBin = { id: string; writeKey: string; private: boolean; createdAt: string; expiresAt: string | null };

function postBin(body: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(BINS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function getBin(id: string) {
  return exports.default.fetch(`${BINS_URL}/${id}`);
}

function putBin(id: string, writeKey: string, body = "[]") {
  return exports.default.fetch(`${BINS_URL}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeKey}` },
    body,
  });
}

function deleteBin(id: string, writeKey: string) {
  return exports.default.fetch(`${BINS_URL}/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${writeKey}` },
  });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.has("X-Bin-Id")).toBe(false);
  expect(await res.json()).toEqual({ error: { code, message: expect.any(String) } });
}

async function countBins(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM bins").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Inserts a public Bin through the repository with this Expiry, returning its Write Key. */
async function storeBin(expiresAt: number | null): Promise<{ bin: Bin; writeKey: string }> {
  const writeKey = generateWriteKey();
  const bin: Bin = {
    id: generateBinId(),
    content: '{"keep": true}',
    isPrivate: false,
    writeKeyHash: await hashKey(writeKey),
    readKeyHash: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    expiresAt,
  };
  await insert(env.DB, bin);
  return { bin, writeKey };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM bins");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("X-Bin-TTL on POST /bins", () => {
  it("is tested against an Instance with neither a default nor a maximum TTL", () => {
    // The default/max rules are covered by expiry-rules.test.ts; over HTTP the test Instance has neither.
    const config = parseConfig(env);
    expect(config.defaultTtlSeconds).toBe(0);
    expect(config.maxTtlSeconds).toBe(0);
  });

  it("sets expiresAt to createdAt + TTL and sends X-Bin-Expires-At", async () => {
    const res = await postBin("{}", { "X-Bin-TTL": "3600" });
    expect(res.status).toBe(201);

    const body = (await res.json()) as CreatedBin;
    expect(body.expiresAt).toBe(new Date(Date.parse(body.createdAt) + 3_600_000).toISOString());
    expect(res.headers.get("X-Bin-Expires-At")).toBe(body.expiresAt);

    const stored = await findLive(env.DB, body.id, Date.now());
    expect(stored?.expiresAt).toBe(Date.parse(body.createdAt) + 3_600_000);
  });

  it("uses the request time for the Expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);

    const res = await postBin("[]", { "X-Bin-TTL": " 60 " });
    const body = (await res.json()) as CreatedBin;
    expect(body.createdAt).toBe("2026-10-09T12:00:00.000Z");
    expect(body.expiresAt).toBe("2026-10-09T12:01:00.000Z");
  });

  it("sends X-Bin-Expires-At on a later GET and PUT", async () => {
    const created = (await (await postBin("{}", { "X-Bin-TTL": "600" })).json()) as CreatedBin;

    const read = await getBin(created.id);
    expect(read.status).toBe(200);
    expect(read.headers.get("X-Bin-Expires-At")).toBe(created.expiresAt);

    const replaced = await putBin(created.id, created.writeKey);
    expect(replaced.status).toBe(200);
    expect(replaced.headers.get("X-Bin-Expires-At")).toBe(created.expiresAt);
    expect(((await replaced.json()) as CreatedBin).expiresAt).toBe(created.expiresAt);
  });

  it("makes a Bin that never expires when the header is absent", async () => {
    const res = await postBin("{}");
    const body = (await res.json()) as CreatedBin;
    expect(body.expiresAt).toBeNull();
    expect(res.headers.has("X-Bin-Expires-At")).toBe(false);
    expect((await findLive(env.DB, body.id, Date.now()))?.expiresAt).toBeNull();
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["a decimal", "1.5"],
    ["not a number", "abc"],
    ["an exponent", "1e3"],
    ["empty", ""],
    ["a plus sign", "+5"],
    ["huge", "99999999999999999999"],
  ])("rejects a TTL that is %s (%j) with 400 invalid_ttl and stores nothing", async (_name, ttl) => {
    await expectError(await postBin("{}", { "X-Bin-TTL": ttl }), 400, "invalid_ttl");
    expect(await countBins()).toBe(0);
  });

  it("checks X-Bin-TTL before the content type and the body", async () => {
    // X-Bin-TTL is a header, so it is checked before any of the body is read.
    const ttl = { "X-Bin-TTL": "0" };
    await expectError(
      await exports.default.fetch(BINS_URL, { method: "POST", headers: { ...ttl, "Content-Type": "text/plain" } }),
      400,
      "invalid_ttl",
    );
    await expectError(await postBin("{", ttl), 400, "invalid_ttl");
    await expectError(await postBin('"str"', ttl), 400, "invalid_ttl");
    await expectError(await postBin(`["${"a".repeat(parseConfig(env).maxBinBytes)}"]`, ttl), 400, "invalid_ttl");
    expect(await countBins()).toBe(0);
  });
});

describe("an expired Bin", () => {
  it.each([
    ["at its Expiry", 0],
    ["after its Expiry", 1],
  ])("is a 404 on GET, PUT and DELETE %s, while its row is still in D1", async (_name, msAfterExpiry) => {
    const { bin, writeKey } = await storeBin(NOW);
    vi.useFakeTimers({ toFake: ["Date"] });

    vi.setSystemTime(NOW - 1);
    expect((await getBin(bin.id)).status).toBe(200);

    vi.setSystemTime(NOW + msAfterExpiry);
    await expectError(await getBin(bin.id), 404, "not_found");
    await expectError(await putBin(bin.id, writeKey), 404, "not_found");
    await expectError(await deleteBin(bin.id, writeKey), 404, "not_found");

    // Not swept yet: the row is still there, untouched by the PUT and the DELETE.
    expect(await countBins()).toBe(1);
    expect(await findLive(env.DB, bin.id, NOW - 1)).toEqual(bin);
  });

  it("expires on its own: a Bin created with a TTL is a 404 once the TTL has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const created = (await (await postBin("{}", { "X-Bin-TTL": "60" })).json()) as CreatedBin;

    vi.setSystemTime(NOW + 59_999);
    expect((await getBin(created.id)).status).toBe(200);

    vi.setSystemTime(NOW + 60_000);
    await expectError(await getBin(created.id), 404, "not_found");
    await expectError(await putBin(created.id, created.writeKey), 404, "not_found");
    await expectError(await deleteBin(created.id, created.writeKey), 404, "not_found");
    expect(await countBins()).toBe(1);
  });

  it("doesn't affect a Bin that never expires", async () => {
    const { bin, writeKey } = await storeBin(null);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW + 100 * 365 * 86_400_000);

    expect((await getBin(bin.id)).status).toBe(200);
    expect((await putBin(bin.id, writeKey)).status).toBe(200);
    expect((await deleteBin(bin.id, writeKey)).status).toBe(204);
  });
});
