import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";

// wrangler.demo.jsonc must match the Demo Instance column of docs/deploy.md.
describe("demo Instance", () => {
  it("parses to the demo Instance values in docs/deploy.md", () => {
    expect(parseConfig(env.TEST_DEMO_VARS)).toEqual({
      maxBinBytes: 102_400,
      defaultTtlSeconds: 14_400,
      maxTtlSeconds: 14_400,
      corsOrigins: "*",
      rateLimitEnabled: true,
    });
  });

  it("sets every Instance var explicitly", () => {
    expect(Object.keys(env.TEST_DEMO_VARS).sort()).toEqual([
      "CORS_ORIGINS",
      "DEFAULT_TTL_SECONDS",
      "MAX_BIN_BYTES",
      "MAX_TTL_SECONDS",
      "RATE_LIMIT_ENABLED",
    ]);
  });
});
