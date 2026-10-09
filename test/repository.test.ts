import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateBinId } from "../src/bins/keys";
import { type Bin, deleteExpired, findLive, insert, remove, replaceContent } from "../src/bins/repository";

const NOW = 1_791_547_200_000; // 2026-10-09T12:00:00.000Z
const HOUR = 3_600_000;

function makeBin(overrides: Partial<Bin> = {}): Bin {
  return {
    id: generateBinId(),
    content: '{"hello": "world"}',
    isPrivate: false,
    writeKeyHash: "a".repeat(64),
    readKeyHash: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: null,
    ...overrides,
  };
}

async function countBins(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM bins").first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM bins");
});

describe("insert / findLive", () => {
  it("round-trips a public Bin", async () => {
    const bin = makeBin();
    await insert(env.DB, bin);
    expect(await findLive(env.DB, bin.id, NOW)).toEqual(bin);
  });

  it("round-trips a Private Bin with an Expiry", async () => {
    const bin = makeBin({ isPrivate: true, readKeyHash: "b".repeat(64), expiresAt: NOW + HOUR });
    await insert(env.DB, bin);
    expect(await findLive(env.DB, bin.id, NOW)).toEqual(bin);
  });

  it("stores the content byte-for-byte", async () => {
    const bin = makeBin({ content: '[ 1,\n  {"z":1, "a":"é"} ]' });
    await insert(env.DB, bin);
    expect((await findLive(env.DB, bin.id, NOW))?.content).toBe(bin.content);
  });

  it("returns null for an unknown id", async () => {
    expect(await findLive(env.DB, generateBinId(), NOW)).toBeNull();
  });

  it("leaves out a Bin whose expiresAt is now or earlier", async () => {
    const bin = makeBin({ expiresAt: NOW });
    await insert(env.DB, bin);
    expect(await findLive(env.DB, bin.id, NOW - 1)).toEqual(bin);
    expect(await findLive(env.DB, bin.id, NOW)).toBeNull();
    expect(await findLive(env.DB, bin.id, NOW + 1)).toBeNull();
  });

  it("rejects a duplicate id", async () => {
    const bin = makeBin();
    await insert(env.DB, bin);
    await expect(insert(env.DB, bin)).rejects.toThrow();
  });
});

describe("replaceContent", () => {
  it("replaces content and updatedAt, keeping everything else", async () => {
    const bin = makeBin({ isPrivate: true, readKeyHash: "b".repeat(64), expiresAt: NOW + HOUR });
    await insert(env.DB, bin);

    expect(await replaceContent(env.DB, bin.id, "[]", NOW + 1000)).toBe(true);
    expect(await findLive(env.DB, bin.id, NOW + 1000)).toEqual({ ...bin, content: "[]", updatedAt: NOW + 1000 });
  });

  it("reports false for an unknown id", async () => {
    expect(await replaceContent(env.DB, generateBinId(), "[]", NOW)).toBe(false);
  });

  it("does not touch an expired Bin", async () => {
    const bin = makeBin({ expiresAt: NOW });
    await insert(env.DB, bin);

    expect(await replaceContent(env.DB, bin.id, "[]", NOW)).toBe(false);
    expect(await findLive(env.DB, bin.id, NOW - 1)).toEqual(bin);
  });
});

describe("remove", () => {
  it("deletes the Bin and reports true", async () => {
    const bin = makeBin();
    await insert(env.DB, bin);

    expect(await remove(env.DB, bin.id, NOW)).toBe(true);
    expect(await findLive(env.DB, bin.id, NOW)).toBeNull();
    expect(await countBins()).toBe(0);
  });

  it("deletes a Bin whose Expiry is still ahead", async () => {
    const bin = makeBin({ expiresAt: NOW + 1 });
    await insert(env.DB, bin);

    expect(await remove(env.DB, bin.id, NOW)).toBe(true);
    expect(await countBins()).toBe(0);
  });

  it("reports false when nothing was deleted", async () => {
    const bin = makeBin();
    await insert(env.DB, bin);
    await remove(env.DB, bin.id, NOW);

    expect(await remove(env.DB, bin.id, NOW)).toBe(false);
  });

  it("does not touch an expired Bin", async () => {
    const atNow = makeBin({ expiresAt: NOW });
    const earlier = makeBin({ expiresAt: NOW - HOUR });
    await insert(env.DB, atNow);
    await insert(env.DB, earlier);

    expect(await remove(env.DB, atNow.id, NOW)).toBe(false);
    expect(await remove(env.DB, earlier.id, NOW)).toBe(false);
    expect(await countBins()).toBe(2);
  });
});

describe("deleteExpired", () => {
  it("deletes only expired Bins", async () => {
    const never = makeBin();
    const later = makeBin({ expiresAt: NOW + 1 });
    const atNow = makeBin({ expiresAt: NOW });
    const earlier = makeBin({ expiresAt: NOW - HOUR });
    for (const bin of [never, later, atNow, earlier]) await insert(env.DB, bin);

    expect(await deleteExpired(env.DB, NOW, 500)).toBe(2);
    expect(await findLive(env.DB, never.id, NOW)).toEqual(never);
    expect(await findLive(env.DB, later.id, NOW)).toEqual(later);
    expect(await countBins()).toBe(2);
  });

  it("deletes at most limit Bins per call", async () => {
    for (let i = 0; i < 5; i++) await insert(env.DB, makeBin({ expiresAt: NOW - i }));
    await insert(env.DB, makeBin());

    expect(await deleteExpired(env.DB, NOW, 2)).toBe(2);
    expect(await countBins()).toBe(4);
    expect(await deleteExpired(env.DB, NOW, 2)).toBe(2);
    expect(await deleteExpired(env.DB, NOW, 2)).toBe(1);
    expect(await deleteExpired(env.DB, NOW, 2)).toBe(0);
    expect(await countBins()).toBe(1);
  });
});
