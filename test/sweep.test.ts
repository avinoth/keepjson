import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sweepExpired } from "../src/bins/expiry";
import { generateBinId } from "../src/bins/keys";
import { type Bin, findLive, insert } from "../src/bins/repository";
import worker from "../src/index";

const NOW = 1_791_547_200_000; // 2026-10-09T12:00:00.000Z
const HOUR = 3_600_000;

function makeBin(expiresAt: number | null): Bin {
  return {
    id: generateBinId(),
    content: "{}",
    isPrivate: false,
    writeKeyHash: "a".repeat(64),
    readKeyHash: null,
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    expiresAt,
  };
}

async function insertAll(bins: Bin[]): Promise<void> {
  for (const bin of bins) await insert(env.DB, bin);
}

async function storedIds(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT id FROM bins ORDER BY id").all<{ id: string }>();
  return results.map((row) => row.id);
}

/** A clock that advances `step` ms every time it is read. */
function steppingClock(step: number): () => number {
  let time = 0;
  return () => {
    const now = time;
    time += step;
    return now;
  };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM bins");
});

describe("sweepExpired", () => {
  it("deletes only expired Bins, including one expiring exactly now", async () => {
    const expired = [makeBin(NOW - HOUR), makeBin(NOW - 1), makeBin(NOW)];
    const kept = [makeBin(NOW + 1), makeBin(NOW + HOUR), makeBin(null), makeBin(null)];
    await insertAll([...expired, ...kept]);

    expect(await sweepExpired(env.DB, NOW)).toBe(3);
    expect(await storedIds()).toEqual(kept.map((bin) => bin.id).sort());
    for (const bin of kept) expect(await findLive(env.DB, bin.id, NOW)).toEqual(bin);
  });

  it("loops over several batches until nothing expired is left", async () => {
    const expired = Array.from({ length: 5 }, (_, i) => makeBin(NOW - i * 1000));
    const kept = [makeBin(null), makeBin(NOW + HOUR)];
    await insertAll([...expired, ...kept]);

    expect(await sweepExpired(env.DB, NOW, { batchSize: 2 })).toBe(5);
    expect(await storedIds()).toEqual(kept.map((bin) => bin.id).sort());
  });

  it("stops after a full last batch once a later call finds nothing", async () => {
    await insertAll(Array.from({ length: 4 }, () => makeBin(NOW - 1)));

    expect(await sweepExpired(env.DB, NOW, { batchSize: 2 })).toBe(4);
    expect(await storedIds()).toEqual([]);
  });

  it("deletes nothing when nothing has expired", async () => {
    await insertAll([makeBin(null), makeBin(NOW + 1)]);

    expect(await sweepExpired(env.DB, NOW, { batchSize: 1 })).toBe(0);
    expect(await storedIds()).toHaveLength(2);
  });

  it("stops when the time budget has run out, leaving the rest for the next run", async () => {
    await insertAll(Array.from({ length: 10 }, (_, i) => makeBin(NOW - i)));

    // Every batch "takes" 10 ms: after the third batch 30 ms have passed, which is past the 25 ms budget.
    expect(await sweepExpired(env.DB, NOW, { batchSize: 1, budgetMs: 25, clock: steppingClock(10) })).toBe(3);
    expect(await storedIds()).toHaveLength(7);

    expect(await sweepExpired(env.DB, NOW, { batchSize: 1, budgetMs: 1000, clock: steppingClock(10) })).toBe(7);
    expect(await storedIds()).toEqual([]);
  });

  it("always runs at least one batch", async () => {
    await insertAll([makeBin(NOW - 1), makeBin(NOW - 1)]);

    expect(await sweepExpired(env.DB, NOW, { batchSize: 1, budgetMs: 0, clock: () => 0 })).toBe(1);
    expect(await storedIds()).toHaveLength(1);
  });
});

describe("scheduled", () => {
  it("sweeps expired Bins and keeps the rest", async () => {
    const now = Date.now();
    const expired = [makeBin(now - HOUR), makeBin(now - 1)];
    const kept = [makeBin(now + HOUR), makeBin(null)];
    await insertAll([...expired, ...kept]);

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "0 * * * *", scheduledTime: now }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await storedIds()).toEqual(kept.map((bin) => bin.id).sort());
  });
});
