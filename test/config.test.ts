import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";

describe("parseConfig", () => {
  it("applies defaults when vars are unset or empty", () => {
    expect(parseConfig({ CORS_ORIGINS: "" })).toEqual({
      maxBinBytes: 102_400,
      defaultTtlSeconds: 0,
      maxTtlSeconds: 0,
      corsOrigins: "*",
      rateLimitEnabled: true,
    });
  });

  it("parses string vars into typed values", () => {
    expect(
      parseConfig({
        MAX_BIN_BYTES: "2048",
        DEFAULT_TTL_SECONDS: "2592000",
        MAX_TTL_SECONDS: "2592000",
        CORS_ORIGINS: "https://a.example, https://b.example",
        RATE_LIMIT_ENABLED: "false",
      }),
    ).toEqual({
      maxBinBytes: 2048,
      defaultTtlSeconds: 2_592_000,
      maxTtlSeconds: 2_592_000,
      corsOrigins: ["https://a.example", "https://b.example"],
      rateLimitEnabled: false,
    });
  });

  it("accepts MAX_BIN_BYTES at the ceiling", () => {
    expect(parseConfig({ MAX_BIN_BYTES: "1000000" }).maxBinBytes).toBe(1_000_000);
  });

  it("rejects MAX_BIN_BYTES above 1,000,000", () => {
    expect(() => parseConfig({ MAX_BIN_BYTES: "1000001" })).toThrow();
  });

  it.each([
    ["MAX_BIN_BYTES", "abc"],
    ["MAX_BIN_BYTES", "0"],
    ["DEFAULT_TTL_SECONDS", "-1"],
    ["MAX_TTL_SECONDS", "1.5"],
    ["RATE_LIMIT_ENABLED", "yes"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => parseConfig({ [name]: value })).toThrow();
  });
});
