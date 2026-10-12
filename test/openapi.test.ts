import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";

const BASE_URL = "https://keepjson.test";
const ORIGIN = "https://a.example";

/** Every error code with its status. */
const ERROR_STATUSES: Record<string, number> = {
  invalid_json: 400,
  invalid_ttl: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  payload_too_large: 413,
  unsupported_media_type: 415,
  invalid_top_level: 422,
  rate_limited: 429,
  internal_error: 500,
};

/** The routes of the API, with the status codes each one can answer. */
const OPERATIONS: { path: string; method: string; statuses: number[]; errorCodes: string[] }[] = [
  { path: "/health", method: "get", statuses: [200, 500], errorCodes: ["internal_error"] },
  {
    path: "/bins",
    method: "post",
    statuses: [201, 400, 413, 415, 422, 429, 500],
    errorCodes: [
      "invalid_json",
      "invalid_ttl",
      "payload_too_large",
      "unsupported_media_type",
      "invalid_top_level",
      "rate_limited",
      "internal_error",
    ],
  },
  {
    path: "/bins/{id}",
    method: "get",
    statuses: [200, 401, 403, 404, 500],
    errorCodes: ["unauthorized", "forbidden", "not_found", "internal_error"],
  },
  {
    path: "/bins/{id}",
    method: "put",
    statuses: [200, 400, 401, 403, 404, 413, 415, 422, 429, 500],
    errorCodes: [
      "invalid_json",
      "unauthorized",
      "forbidden",
      "not_found",
      "payload_too_large",
      "unsupported_media_type",
      "invalid_top_level",
      "rate_limited",
      "internal_error",
    ],
  },
  {
    path: "/bins/{id}",
    method: "delete",
    statuses: [204, 401, 403, 404, 429, 500],
    errorCodes: ["unauthorized", "forbidden", "not_found", "rate_limited", "internal_error"],
  },
];

const METADATA_HEADERS = ["X-Bin-Id", "X-Bin-Private", "X-Bin-Created-At", "X-Bin-Updated-At", "X-Bin-Expires-At"];

// A loose view of the OpenAPI spec: just enough structure for the checks below.
type Json = Record<string, unknown>;
type Parameter = { name: string; in: string; required?: boolean; schema?: Json };
type MediaType = { schema?: Json; examples?: Record<string, { value: { error: { code: string } } }> };
type ResponseSpec = { description: string; headers?: Record<string, Json>; content?: Record<string, MediaType> };
type Operation = {
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, MediaType> };
  responses: Record<string, ResponseSpec>;
  security?: Record<string, string[]>[];
};
type Spec = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Json>; securitySchemes: Record<string, Json> };
};

let spec: Spec;

beforeAll(async () => {
  const res = await exports.default.fetch(`${BASE_URL}/openapi.json`);
  expect(res.status).toBe(200);
  spec = (await res.json()) as Spec;
});

function operation(path: string, method: string): Operation {
  const op = spec.paths[path]?.[method];
  if (!op) throw new Error(`No ${method.toUpperCase()} ${path} in the spec`);
  return op;
}

function response(path: string, method: string, status: number): ResponseSpec {
  const res = operation(path, method).responses[String(status)];
  if (!res) throw new Error(`No ${status} for ${method.toUpperCase()} ${path} in the spec`);
  return res;
}

/** Follows a local `$ref` such as `#/components/schemas/Error`; undefined when it doesn't resolve. */
function resolveRef(ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = spec;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof node !== "object" || node === null || !(key in node)) return undefined;
    node = (node as Json)[key];
  }
  return node;
}

/** `schema` itself, or what its `$ref` points at. */
function deref(schema: Json | undefined): Json | undefined {
  return typeof schema?.$ref === "string" ? (resolveRef(schema.$ref) as Json | undefined) : schema;
}

function collectRefs(node: unknown, refs: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs);
  } else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") refs.push(value);
      else collectRefs(value, refs);
    }
  }
  return refs;
}

/** A header name in the spec, matched in any case (HTTP header names are case-insensitive). */
function headerNames(res: ResponseSpec): string[] {
  return Object.keys(res.headers ?? {}).map((name) => name.toLowerCase());
}

function headerParameters(op: Operation): string[] {
  return (op.parameters ?? []).filter((p) => p.in === "header").map((p) => p.name.toLowerCase());
}

/** Calls the app directly with an env in which D1 and the limiters throw, and rate limiting is on. */
async function sendWithoutD1(path: string): Promise<Response> {
  const fail = () => {
    throw new Error("must not be called");
  };
  const throwingDb = new Proxy({} as D1Database, { get: fail });
  const throwingLimiter: RateLimit = { limit: fail };
  const testEnv: Env = {
    ...env,
    DB: throwingDb,
    RATE_LIMIT_ENABLED: "true",
    CREATE_LIMITER: throwingLimiter,
    WRITE_LIMITER: throwingLimiter,
  };
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${BASE_URL}${path}`, { headers: { Origin: ORIGIN } }), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("GET /openapi.json", () => {
  it("returns JSON with no-store and CORS headers", async () => {
    const res = await exports.default.fetch(`${BASE_URL}/openapi.json`, { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("X-Bin-Id");
  });

  it("isn't rate limited and doesn't touch D1", async () => {
    const res = await sendWithoutD1("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(((await res.json()) as Spec).openapi).toMatch(/^3\.1\./);
  });

  it("is an OpenAPI 3.1 spec titled keepjson", () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    expect(spec.info.title).toBe("keepjson");
    expect(spec.info.version).toMatch(/\S/);
    expect(spec.info.description).toMatch(/Bin/);
  });

  it("lists exactly the routes in the spec", () => {
    expect(Object.keys(spec.paths).sort()).toEqual(["/bins", "/bins/{id}", "/health"]);
    expect(Object.keys(spec.paths["/health"] ?? {})).toEqual(["get"]);
    expect(Object.keys(spec.paths["/bins"] ?? {})).toEqual(["post"]);
    expect(Object.keys(spec.paths["/bins/{id}"] ?? {}).sort()).toEqual(["delete", "get", "put"]);
  });

  it.each(OPERATIONS)("$method $path lists its documented status codes", ({ path, method, statuses }) => {
    const op = operation(path, method);
    expect(op.summary).toMatch(/\S/);
    expect(Object.keys(op.responses).map(Number).sort()).toEqual([...statuses].sort());
    for (const res of Object.values(op.responses)) expect(res.description).toMatch(/\S/);
  });

  it.each(OPERATIONS)("$method $path shows each error code under its status", ({ path, method, errorCodes }) => {
    const shown: string[] = [];
    for (const [status, res] of Object.entries(operation(path, method).responses)) {
      if (Number(status) < 400) continue;
      const media = res.content?.["application/json"];
      expect(media?.schema?.$ref).toBe("#/components/schemas/Error");
      for (const example of Object.values(media?.examples ?? {})) {
        const { code } = example.value.error;
        expect(ERROR_STATUSES[code]).toBe(Number(status));
        shown.push(code);
      }
    }
    expect(shown.sort()).toEqual([...errorCodes].sort());
  });

  it("has one shared error schema whose code enum is every code in the spec", () => {
    const error = spec.components.schemas.Error as {
      required?: string[];
      properties: { error: { required?: string[]; properties: { code: { enum: string[] }; message: Json } } };
    };
    expect(error.required).toEqual(["error"]);
    expect(error.properties.error.required?.sort()).toEqual(["code", "message"]);
    expect(error.properties.error.properties.code.enum.sort()).toEqual(Object.keys(ERROR_STATUSES).sort());
    expect(error.properties.error.properties.message.type).toBe("string");
  });

  it("resolves every $ref within the spec", () => {
    const refs = collectRefs(spec);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(resolveRef(ref), ref).toBeDefined();
  });

  it("describes the metadata headers on every response that sends them", () => {
    for (const [path, method, status] of [
      ["/bins", "post", 201],
      ["/bins/{id}", "get", 200],
      ["/bins/{id}", "put", 200],
    ] as const) {
      const res = response(path, method, status);
      for (const header of METADATA_HEADERS) expect(headerNames(res)).toContain(header.toLowerCase());
      expect(res.headers?.["X-Bin-Expires-At"]?.required).not.toBe(true);
      expect(res.headers?.["X-Bin-Id"]?.required).toBe(true);
    }
    expect(headerNames(response("/bins", "post", 201))).toContain("location");
  });

  it("describes Retry-After on every 429", () => {
    for (const { path, method, statuses } of OPERATIONS) {
      if (statuses.includes(429)) expect(headerNames(response(path, method, 429))).toContain("retry-after");
    }
  });

  it("describes the request headers and the id path parameter", () => {
    expect(headerParameters(operation("/bins", "post")).sort()).toEqual(["x-bin-private", "x-bin-ttl"]);
    for (const method of ["get", "put", "delete"]) {
      const id = operation("/bins/{id}", method).parameters?.find((p) => p.in === "path");
      expect(id).toMatchObject({ name: "id", required: true, schema: { type: "string" } });
    }
  });

  it("describes the create and replace bodies as any JSON object or array", () => {
    for (const [path, method] of [
      ["/bins", "post"],
      ["/bins/{id}", "put"],
    ] as const) {
      const body = operation(path, method).requestBody;
      expect(body?.required).toBe(true);
      expect(Object.keys(body?.content ?? {})).toEqual(["application/json"]);
      const schema = deref(body?.content["application/json"]?.schema) as Json & { [K in "anyOf" | "oneOf"]?: Json[] };
      expect((schema.anyOf ?? schema.oneOf)?.map((s) => s.type).sort()).toEqual(["array", "object"]);
    }
    expect(operation("/bins/{id}", "get").requestBody).toBeUndefined();
  });

  it("describes the success bodies", () => {
    const created = deref(response("/bins", "post", 201).content?.["application/json"]?.schema) as {
      properties: Json;
      required: string[];
    };
    expect(Object.keys(created.properties).sort()).toEqual(
      ["createdAt", "expiresAt", "id", "private", "readKey", "writeKey"].sort(),
    );
    expect(created.required).not.toContain("readKey");

    const replaced = deref(response("/bins/{id}", "put", 200).content?.["application/json"]?.schema) as {
      properties: Json;
    };
    expect(Object.keys(replaced.properties).sort()).toEqual(
      ["createdAt", "expiresAt", "id", "private", "updatedAt"].sort(),
    );

    expect(Object.keys(response("/bins/{id}", "get", 200).content ?? {})).toEqual(["application/json"]);
    expect(response("/bins/{id}", "delete", 204).content).toBeUndefined();
    expect(response("/health", "get", 200).content?.["application/json"]?.schema).toBeDefined();
  });

  it("declares Bearer auth: required on PUT and DELETE, optional on GET /bins/{id}, absent elsewhere", () => {
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(operation("/bins/{id}", "put").security).toEqual([{ bearerAuth: [] }]);
    expect(operation("/bins/{id}", "delete").security).toEqual([{ bearerAuth: [] }]);
    expect(operation("/bins/{id}", "get").security).toEqual(expect.arrayContaining([{}, { bearerAuth: [] }]));
    expect(operation("/bins", "post").security ?? []).toEqual([]);
    expect(operation("/health", "get").security ?? []).toEqual([]);
  });

  it("uses the vocabulary of CONTEXT.md", () => {
    const text = JSON.stringify(spec).toLowerCase();
    for (const word of ["document", "record", "masterkey", "apikey", "token"]) expect(text).not.toContain(word);
  });
});

describe("GET /docs", () => {
  it("returns an HTML page that loads /openapi.json", async () => {
    const res = await exports.default.fetch(`${BASE_URL}/docs`, { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const html = await res.text();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('"/openapi.json"');
  });

  it("isn't rate limited and doesn't touch D1", async () => {
    const res = await sendWithoutD1("/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});
