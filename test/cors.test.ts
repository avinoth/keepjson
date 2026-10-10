import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateBinId } from "../src/bins/keys";
import { RATE_LIMIT_PERIOD_SECONDS } from "../src/bins/rate-limit";
import { app } from "../src/index";

const BASE_URL = "https://keepjson.test";
const ALLOWED_ORIGIN = "https://b.example";
const OTHER_ORIGIN = "https://evil.example";
const ALLOWLIST = "https://a.example, https://b.example";

const ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"];
const ALLOWED_HEADERS = ["Authorization", "Content-Type", "X-Bin-Private", "X-Bin-TTL"];
const EXPOSED_HEADERS = [
  "X-Bin-Id",
  "X-Bin-Private",
  "X-Bin-Created-At",
  "X-Bin-Updated-At",
  "X-Bin-Expires-At",
  "Location",
  "Retry-After",
];

/** A limiter binding that denies every call. */
const denyingLimiter: RateLimit = {
  async limit() {
    return { success: false };
  },
};

/**
 * Calls the app directly, so `CORS_ORIGINS` and the limiter bindings can be overridden per test. With no
 * `corsOrigins`, the test worker's own value (`*`) applies.
 */
async function send(
  path: string,
  init: RequestInit = {},
  options: { corsOrigins?: string; rateLimited?: boolean } = {},
): Promise<Response> {
  const testEnv: Env = { ...env };
  if (options.corsOrigins !== undefined) testEnv.CORS_ORIGINS = options.corsOrigins;
  if (options.rateLimited) {
    testEnv.RATE_LIMIT_ENABLED = "true";
    testEnv.CREATE_LIMITER = denyingLimiter;
    testEnv.WRITE_LIMITER = denyingLimiter;
  }
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${BASE_URL}${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function preflight(path: string, origin: string, method: string, options?: { corsOrigins?: string }) {
  return send(
    path,
    {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    },
    options,
  );
}

function postBin(origin: string, options?: { corsOrigins?: string; rateLimited?: boolean }) {
  return send(
    "/bins",
    { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: '{"keep": true}' },
    options,
  );
}

/** The comma-separated values of a header, trimmed and lowercased (header names are case-insensitive). */
function listHeader(res: Response, name: string): string[] {
  return (res.headers.get(name) ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function expectExposedHeaders(res: Response) {
  const exposed = listHeader(res, "Access-Control-Expose-Headers");
  for (const header of EXPOSED_HEADERS) expect(exposed).toContain(header.toLowerCase());
}

function expectCommonHeaders(res: Response) {
  expect(res.headers.has("Access-Control-Allow-Credentials")).toBe(false);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
}

async function countBins(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM bins").first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM bins");
});

describe("CORS with CORS_ORIGINS=*", () => {
  it("runs with the default CORS_ORIGINS", () => {
    expect(env.CORS_ORIGINS).toBe("*");
  });

  it.each([
    ["/bins", "POST"],
    ["/bins/V1StGXR8_Z5jdHi6B-myT", "PUT"],
    ["/bins/V1StGXR8_Z5jdHi6B-myT", "DELETE"],
    ["/bins/V1StGXR8_Z5jdHi6B-myT", "GET"],
  ])("answers a preflight on %s (%s) with 204 and the allow headers", async (path, method) => {
    const res = await preflight(path, OTHER_ORIGIN, method);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const methods = listHeader(res, "Access-Control-Allow-Methods");
    for (const allowed of ALLOWED_METHODS) expect(methods).toContain(allowed.toLowerCase());
    const headers = listHeader(res, "Access-Control-Allow-Headers");
    for (const allowed of ALLOWED_HEADERS) expect(headers).toContain(allowed.toLowerCase());
    expectCommonHeaders(res);
    expect(await res.text()).toBe("");
  });

  it("answers preflights without rate limiting them or touching the Bins", async () => {
    const res = await preflight("/bins", OTHER_ORIGIN, "POST", undefined);
    expect(res.status).toBe(204);
    const limited = await send(
      "/bins",
      { method: "OPTIONS", headers: { Origin: OTHER_ORIGIN, "Access-Control-Request-Method": "POST" } },
      { rateLimited: true },
    );
    expect(limited.status).toBe(204);
    expect(limited.headers.has("Retry-After")).toBe(false);
    expect(await countBins()).toBe(0);
  });

  it("sends ACAO * and exposes the metadata headers on POST and GET", async () => {
    const created = await postBin(OTHER_ORIGIN);
    expect(created.status).toBe(201);
    expect(created.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expectExposedHeaders(created);
    expectCommonHeaders(created);
    const { id } = (await created.json()) as { id: string };

    const read = await send(`/bins/${id}`, { headers: { Origin: OTHER_ORIGIN } });
    expect(read.status).toBe(200);
    expect(read.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expectExposedHeaders(read);
    expectCommonHeaders(read);
  });

  it("sends the CORS headers on GET /health", async () => {
    const res = await send("/health", { headers: { Origin: OTHER_ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expectCommonHeaders(res);
  });

  it("sends the CORS headers on 404 responses", async () => {
    for (const path of [`/bins/${generateBinId()}`, "/bins/not-an-id", "/nowhere"]) {
      const res = await send(path, { headers: { Origin: OTHER_ORIGIN } });
      expect(res.status).toBe(404);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expectExposedHeaders(res);
      expectCommonHeaders(res);
    }
  });

  it("sends the CORS headers on 401 responses", async () => {
    const created = await send("/bins", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bin-Private": "true" },
      body: "{}",
    });
    const { id } = (await created.json()) as { id: string };
    const res = await send(`/bins/${id}`, { headers: { Origin: OTHER_ORIGIN } });
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expectExposedHeaders(res);
    expectCommonHeaders(res);
  });

  it("sends the CORS headers, exposing Retry-After, on 429 responses", async () => {
    const res = await postBin(OTHER_ORIGIN, { rateLimited: true });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(RATE_LIMIT_PERIOD_SECONDS));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expectExposedHeaders(res);
    expectCommonHeaders(res);
  });
});

describe("CORS with an allowlist", () => {
  const options = { corsOrigins: ALLOWLIST };

  it("echoes an allowed origin on a preflight", async () => {
    const res = await preflight(`/bins/${generateBinId()}`, ALLOWED_ORIGIN, "PUT", options);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(listHeader(res, "Vary")).toContain("origin");
    expect(listHeader(res, "Access-Control-Allow-Methods")).toContain("put");
    expectCommonHeaders(res);
  });

  it("sends no ACAO header to a disallowed origin on a preflight", async () => {
    const res = await preflight("/bins", OTHER_ORIGIN, "POST", options);
    expect(res.status).toBe(204);
    expect(res.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(listHeader(res, "Vary")).toContain("origin");
    expectCommonHeaders(res);
  });

  it("echoes an allowed origin on actual requests", async () => {
    const created = await postBin(ALLOWED_ORIGIN, options);
    expect(created.status).toBe(201);
    expect(created.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(listHeader(created, "Vary")).toContain("origin");
    expectExposedHeaders(created);
    expectCommonHeaders(created);
    const { id } = (await created.json()) as { id: string };

    const read = await send(`/bins/${id}`, { headers: { Origin: "https://a.example" } }, options);
    expect(read.status).toBe(200);
    expect(read.headers.get("Access-Control-Allow-Origin")).toBe("https://a.example");
    expect(listHeader(read, "Vary")).toContain("origin");
  });

  it("sends no ACAO header to a disallowed origin on actual requests", async () => {
    const created = await postBin(OTHER_ORIGIN, options);
    expect(created.status).toBe(201);
    expect(created.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(listHeader(created, "Vary")).toContain("origin");
    expectCommonHeaders(created);
    const { id } = (await created.json()) as { id: string };

    for (const origin of [OTHER_ORIGIN, "https://b.example.evil.example", "http://b.example", null]) {
      const headers: Record<string, string> = origin === null ? {} : { Origin: origin };
      const read = await send(`/bins/${id}`, { headers }, options);
      expect(read.status).toBe(200);
      expect(read.headers.has("Access-Control-Allow-Origin")).toBe(false);
    }
  });

  it("echoes an allowed origin on error responses", async () => {
    const notFound = await send(`/bins/${generateBinId()}`, { headers: { Origin: ALLOWED_ORIGIN } }, options);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);

    const limited = await postBin(ALLOWED_ORIGIN, { ...options, rateLimited: true });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expectExposedHeaders(limited);
  });
});
