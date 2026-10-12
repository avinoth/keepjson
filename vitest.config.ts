import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { unstable_readConfig } from "wrangler";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          // The demo environment's vars as wrangler resolves them, for test/demo-config.test.ts. The test worker
          // itself runs with the top-level config.
          TEST_DEMO_VARS: unstable_readConfig({ config: "./wrangler.jsonc", env: "demo" }).vars,
          // These bindings override the wrangler.jsonc vars. Rate limiting is off for the test worker: the real
          // CREATE_LIMITER (10 per 60 s) would start rejecting the many Bins the tests create from one client.
          // test/rate-limit.test.ts turns it back on with stub limiter bindings.
          RATE_LIMIT_ENABLED: "false",
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
