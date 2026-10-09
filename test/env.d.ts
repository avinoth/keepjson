// Test-only bindings, injected by vitest.config.ts.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    TEST_DEMO_VARS: Record<string, unknown>;
  }
}
