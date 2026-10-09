import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hashKey, isValidBinId } from "../src/bins/keys";
import { findLive } from "../src/bins/repository";
import { parseConfig } from "../src/config";

const BINS_URL = "https://keepjson.test/bins";
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const { maxBinBytes } = parseConfig(env);

type CreatedBin = { id: string; writeKey: string; private: boolean; createdAt: string; expiresAt: string | null };

function postBin(body: BodyInit | null, headers: Record<string, string> = { "Content-Type": "application/json" }) {
  return exports.default.fetch(BINS_URL, { method: "POST", headers, body });
}

/** A body sent as a stream, so the request carries no Content-Length. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // Several chunks, so the size check has to add them up.
      for (let i = 0; i < bytes.byteLength; i += 4096) controller.enqueue(bytes.slice(i, i + 4096));
      controller.close();
    },
  });
}

/** A JSON array of exactly `byteCount` bytes. */
function jsonArrayOfBytes(byteCount: number): string {
  return `["${"a".repeat(byteCount - 4)}"]`;
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  expect(body.error.message.length).toBeGreaterThan(0);
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM bins");
});

describe("POST /bins", () => {
  it.each([
    ["an object", '{"hello": "world", "n": [1, 2, 3]}'],
    ["an array", '[1, "two", {"three": 3}]'],
    ["an empty object", "{}"],
    ["an empty array", "[]"],
  ])("creates a Bin from %s", async (_name, content) => {
    const before = Date.now();
    const res = await postBin(content);
    expect(res.status).toBe(201);

    const body = (await res.json()) as CreatedBin;
    expect(Object.keys(body).sort()).toEqual(["createdAt", "expiresAt", "id", "private", "writeKey"]);
    expect(isValidBinId(body.id)).toBe(true);
    expect(body.writeKey).toMatch(/^kj_w_/);
    expect(body.private).toBe(false);
    expect(body.createdAt).toMatch(ISO_UTC);
    expect(Date.parse(body.createdAt)).toBeGreaterThanOrEqual(before);
    expect(body.expiresAt).toBeNull();

    const stored = await findLive(env.DB, body.id, Date.now());
    expect(stored?.content).toBe(content);
  });

  it("sends Location, the metadata headers and Cache-Control", async () => {
    const res = await postBin("{}");
    const body = (await res.json()) as CreatedBin;

    expect(res.headers.get("Location")).toBe(`/bins/${body.id}`);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Bin-Id")).toBe(body.id);
    expect(res.headers.get("X-Bin-Private")).toBe("false");
    expect(res.headers.get("X-Bin-Created-At")).toBe(body.createdAt);
    expect(res.headers.get("X-Bin-Updated-At")).toBe(body.createdAt);
    expect(res.headers.has("X-Bin-Expires-At")).toBe(false);
  });

  it("stores the content byte-for-byte", async () => {
    const content = '\n  [ {"z": 1,   "a": "é ✓"},\t1.50, 1e3 ]  \n';
    const body = (await (await postBin(content)).json()) as CreatedBin;
    expect((await findLive(env.DB, body.id, Date.now()))?.content).toBe(content);
  });

  it("stores only the hash of the writeKey", async () => {
    const body = (await (await postBin('{"a": 1}')).json()) as CreatedBin;

    const stored = await findLive(env.DB, body.id, Date.now());
    expect(stored?.writeKeyHash).toBe(await hashKey(body.writeKey));
    expect(stored?.readKeyHash).toBeNull();
    expect(stored?.isPrivate).toBe(false);
    expect(stored?.expiresAt).toBeNull();
    expect(stored?.updatedAt).toBe(stored?.createdAt);

    const row = await env.DB.prepare("SELECT * FROM bins WHERE id = ?").bind(body.id).first();
    expect(row).not.toBeNull();
    for (const value of Object.values(row ?? {})) {
      expect(String(value)).not.toContain(body.writeKey);
      expect(String(value)).not.toContain(body.writeKey.slice("kj_w_".length));
    }
  });

  it("accepts a Content-Type with parameters, in any case", async () => {
    expect((await postBin("{}", { "Content-Type": "application/json; charset=utf-8" })).status).toBe(201);
    expect((await postBin("{}", { "Content-Type": "Application/JSON" })).status).toBe(201);
  });

  it("accepts a body without Content-Length", async () => {
    expect((await postBin(streamOf('{"a": 1}'))).status).toBe(201);
  });

  describe("size limit", () => {
    it("accepts a body of exactly MAX_BIN_BYTES", async () => {
      const content = jsonArrayOfBytes(maxBinBytes);
      expect(new TextEncoder().encode(content).byteLength).toBe(maxBinBytes);

      const res = await postBin(content);
      expect(res.status).toBe(201);
      const body = (await res.json()) as CreatedBin;
      expect((await findLive(env.DB, body.id, Date.now()))?.content).toBe(content);
    });

    it("rejects a body one byte over MAX_BIN_BYTES with 413", async () => {
      await expectError(await postBin(jsonArrayOfBytes(maxBinBytes + 1)), 413, "payload_too_large");
    });

    it("accepts a streamed body of exactly MAX_BIN_BYTES", async () => {
      expect((await postBin(streamOf(jsonArrayOfBytes(maxBinBytes)))).status).toBe(201);
    });

    it("rejects a streamed body one byte over MAX_BIN_BYTES with 413, counting the actual bytes", async () => {
      await expectError(await postBin(streamOf(jsonArrayOfBytes(maxBinBytes + 1))), 413, "payload_too_large");
    });

    it("counts bytes, not characters", async () => {
      // "é" is 2 bytes in UTF-8, so this is maxBinBytes + 1 bytes but fewer characters.
      const content = `["${"é"}${"a".repeat(maxBinBytes - 5)}"]`;
      await expectError(await postBin(streamOf(content)), 413, "payload_too_large");
    });

    it("rejects an oversized Content-Length with 413 without reading the body", async () => {
      // The stream never ends, so the request would hang if the body were read.
      const neverEnds = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
      const res = await postBin(neverEnds, {
        "Content-Type": "application/json",
        "Content-Length": String(maxBinBytes + 1),
      });
      await expectError(res, 413, "payload_too_large");
    });
  });

  describe("validation", () => {
    it("rejects a missing Content-Type with 415", async () => {
      await expectError(await postBin("{}", {}), 415, "unsupported_media_type");
    });

    it.each(["text/plain", "application/x-www-form-urlencoded", "application/jsonx", "application/json-patch+json"])(
      "rejects Content-Type %s with 415",
      async (contentType) => {
        await expectError(await postBin("{}", { "Content-Type": contentType }), 415, "unsupported_media_type");
      },
    );

    it.each(["", "{", '{"a": 1,}', "[1, 2", "{'a': 1}", "undefined", '{"a": 1} x'])(
      "rejects invalid JSON %j with 400",
      async (content) => {
        await expectError(await postBin(content), 400, "invalid_json");
      },
    );

    it("rejects a body that isn't valid UTF-8 with 400", async () => {
      await expectError(await postBin(new Uint8Array([0x5b, 0x22, 0xff, 0x22, 0x5d])), 400, "invalid_json");
    });

    it.each(['"str"', "1", "null", "true"])("rejects top-level %s with 422", async (content) => {
      await expectError(await postBin(content), 422, "invalid_top_level");
    });

    it("checks the content type before the size", async () => {
      await expectError(
        await postBin(jsonArrayOfBytes(maxBinBytes + 1), { "Content-Type": "text/plain" }),
        415,
        "unsupported_media_type",
      );
    });

    it("checks the size before parsing", async () => {
      await expectError(await postBin(`[${"x".repeat(maxBinBytes)}`), 413, "payload_too_large");
    });

    it("stores nothing when the body is rejected", async () => {
      await postBin('"str"');
      await postBin("{", { "Content-Type": "text/plain" });
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM bins").first<{ n: number }>();
      expect(row?.n).toBe(0);
    });
  });
});

describe("error responses", () => {
  it("sends the error shape for an unknown route", async () => {
    await expectError(await exports.default.fetch("https://keepjson.test/nope"), 404, "not_found");
  });
});
