import { describe, expect, it } from "vitest";
import { resolveExpiresAt } from "../src/bins/expiry";
import { type Config, parseConfig } from "../src/config";
import { ApiError } from "../src/errors";

const NOW = 1_791_547_200_000; // 2026-10-09T12:00:00.000Z
const DAY = 86_400;

function config(ttl: { defaultTtlSeconds?: number; maxTtlSeconds?: number } = {}): Config {
  return { ...parseConfig({}), defaultTtlSeconds: 0, maxTtlSeconds: 0, ...ttl };
}

function expectInvalidTtl(run: () => unknown) {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).code).toBe("invalid_ttl");
    return;
  }
  expect.unreachable("expected invalid_ttl");
}

describe("resolveExpiresAt", () => {
  describe("with X-Bin-TTL", () => {
    it("sets the Expiry to now + TTL when there is no maximum", () => {
      expect(resolveExpiresAt("60", config(), NOW)).toBe(NOW + 60_000);
      expect(resolveExpiresAt("1", config(), NOW)).toBe(NOW + 1000);
      expect(resolveExpiresAt(String(365 * DAY), config(), NOW)).toBe(NOW + 365 * DAY * 1000);
    });

    it("sets the Expiry to now + TTL when TTL is below the maximum", () => {
      expect(resolveExpiresAt("3600", config({ maxTtlSeconds: DAY }), NOW)).toBe(NOW + 3_600_000);
    });

    it("accepts a TTL equal to the maximum", () => {
      expect(resolveExpiresAt(String(DAY), config({ maxTtlSeconds: DAY }), NOW)).toBe(NOW + DAY * 1000);
    });

    it("rejects a TTL above the maximum", () => {
      expectInvalidTtl(() => resolveExpiresAt(String(DAY + 1), config({ maxTtlSeconds: DAY }), NOW));
    });

    it("ignores the default when the header is sent", () => {
      expect(resolveExpiresAt("60", config({ defaultTtlSeconds: DAY, maxTtlSeconds: 30 * DAY }), NOW)).toBe(
        NOW + 60_000,
      );
    });

    it("ignores surrounding whitespace and leading zeros", () => {
      expect(resolveExpiresAt("  60\t", config(), NOW)).toBe(NOW + 60_000);
      expect(resolveExpiresAt("007", config(), NOW)).toBe(NOW + 7000);
    });

    it.each([
      ["zero", "0"],
      ["zeros", "000"],
      ["negative", "-1"],
      ["a plus sign", "+5"],
      ["a decimal", "1.5"],
      ["a trailing dot", "5."],
      ["an exponent", "1e3"],
      ["hex", "0x10"],
      ["not a number", "abc"],
      ["empty", ""],
      ["only whitespace", "   "],
      ["two numbers", "1 2"],
      ["a unit", "60s"],
      ["non-ASCII digits", "٦٠"],
      ["beyond a safe integer", "9007199254740993"],
      ["huge", "9".repeat(400)],
      ["so large the Expiry isn't a valid date", String(Number.MAX_SAFE_INTEGER)],
    ])("rejects %s (%j)", (_name, header) => {
      expectInvalidTtl(() => resolveExpiresAt(header, config(), NOW));
    });
  });

  describe("without X-Bin-TTL", () => {
    it("uses the default when one is set", () => {
      expect(resolveExpiresAt(undefined, config({ defaultTtlSeconds: DAY }), NOW)).toBe(NOW + DAY * 1000);
    });

    it("uses the default, not the maximum, when both are set", () => {
      expect(resolveExpiresAt(undefined, config({ defaultTtlSeconds: DAY, maxTtlSeconds: 30 * DAY }), NOW)).toBe(
        NOW + DAY * 1000,
      );
    });

    it("uses the maximum when only a maximum is set", () => {
      expect(resolveExpiresAt(undefined, config({ maxTtlSeconds: 30 * DAY }), NOW)).toBe(NOW + 30 * DAY * 1000);
    });

    it("never expires when there is neither a default nor a maximum", () => {
      expect(resolveExpiresAt(undefined, config(), NOW)).toBeNull();
      expect(resolveExpiresAt(null, config(), NOW)).toBeNull();
    });
  });
});
