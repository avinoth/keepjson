import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateBinId } from "../src/bins/keys";
import { insert } from "../src/bins/repository";

const BASE_URL = "https://keepjson.test";

type CreatedBin = { id: string; writeKey: string; private: boolean; createdAt: string; expiresAt: string | null };

async function createBin(content: string): Promise<{ res: Response; body: CreatedBin }> {
  const res = await exports.default.fetch(`${BASE_URL}/bins`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: content,
  });
  expect(res.status).toBe(201);
  return { res, body: (await res.json()) as CreatedBin };
}

function getBin(id: string) {
  return exports.default.fetch(`${BASE_URL}/bins/${id}`);
}

async function expectNotFound(res: Response) {
  expect(res.status).toBe(404);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.has("X-Bin-Id")).toBe(false);
  expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM bins");
});

describe("GET /bins/:id", () => {
  it.each([
    ["an object", '{ "b" : 1,\n  "a":[ 2 ,3] }'],
    ["an array", '[ 3, "two",\t{"z": null, "a": true} ]'],
    ["an empty object", "{}"],
    ["an empty array", "[]"],
    ["unicode", '{"é": "naïve ✓", "emoji": "🎉", "escaped": "\\u00e9"}'],
    ["surrounding whitespace and number formats", "\n  [1.50, 1e3, -0, 10000000000000000000001]  \n"],
  ])("returns %s exactly as it was created", async (_name, content) => {
    const { body: created } = await createBin(content);

    const res = await getBin(created.id);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
  });

  it("returns the stored bytes, not a re-encoding", async () => {
    // Multi-byte UTF-8, an escape that JSON.parse would turn into "é", and a trailing newline.
    const content = '{ "z": "é ✓ 🎉", "a": "\\u00e9" }\n';
    const { body: created } = await createBin(content);

    const res = await getBin(created.id);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new TextEncoder().encode(content));
  });

  it("sends the content type, the metadata headers and Cache-Control", async () => {
    const { res: createRes, body: created } = await createBin('{"a": 1}');

    const res = await getBin(created.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Bin-Id")).toBe(created.id);
    expect(res.headers.get("X-Bin-Private")).toBe("false");
    expect(res.headers.get("X-Bin-Created-At")).toBe(created.createdAt);
    expect(res.headers.get("X-Bin-Updated-At")).toBe(created.createdAt);
    expect(res.headers.has("X-Bin-Expires-At")).toBe(false);
    for (const header of ["X-Bin-Id", "X-Bin-Private", "X-Bin-Created-At", "X-Bin-Updated-At"]) {
      expect(res.headers.get(header)).toBe(createRes.headers.get(header));
    }
  });

  it("never sends the writeKey", async () => {
    const { body: created } = await createBin('{"a": 1}');

    const res = await getBin(created.id);
    expect(await res.text()).not.toContain(created.writeKey);
    for (const [, value] of res.headers) expect(value).not.toContain(created.writeKey);
  });

  describe("not found", () => {
    it("returns 404 for an unknown id", async () => {
      await expectNotFound(await getBin(generateBinId()));
    });

    it.each([
      ["too short", "V1StGXR8_Z5jdHi6B-my"],
      ["too long", "V1StGXR8_Z5jdHi6B-myTx"],
      ["a bad character", "V1StGXR8_Z5jdHi6B-my!"],
      ["a dot", "V1StGXR8_Z5jdHi6B-my."],
      ["an encoded space", "V1StGXR8_Z5jdHi6B-my%20"],
      ["a single character", "x"],
    ])("returns 404 for an id that is %s", async (_name, id) => {
      await expectNotFound(await getBin(id));
    });

    it("rejects a malformed id before looking it up", async () => {
      // A row with a malformed id can't come from the API; it would only be served if D1 were asked.
      const id = "too-short";
      await insert(env.DB, {
        id,
        content: "{}",
        isPrivate: false,
        writeKeyHash: "a".repeat(64),
        readKeyHash: null,
        createdAt: 0,
        updatedAt: 0,
        expiresAt: null,
      });
      await expectNotFound(await getBin(id));
    });
  });
});
