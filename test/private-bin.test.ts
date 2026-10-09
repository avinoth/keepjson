import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateReadKey, generateWriteKey, hashKey } from "../src/bins/keys";
import { findLive } from "../src/bins/repository";

const BASE_URL = "https://keepjson.test";

type CreatedBin = {
  id: string;
  writeKey: string;
  readKey?: string;
  private: boolean;
  createdAt: string;
  expiresAt: string | null;
};

async function createBin(
  content: string,
  headers: Record<string, string> = {},
): Promise<{ res: Response; body: CreatedBin }> {
  const res = await exports.default.fetch(`${BASE_URL}/bins`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: content,
  });
  expect(res.status).toBe(201);
  return { res, body: (await res.json()) as CreatedBin };
}

function createPrivateBin(content = '{"secret": true}') {
  return createBin(content, { "X-Bin-Private": "true" });
}

function getBin(id: string, authorization?: string) {
  return exports.default.fetch(`${BASE_URL}/bins/${id}`, {
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.has("X-Bin-Id")).toBe(false);
  expect(await res.json()).toEqual({ error: { code, message: expect.any(String) } });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM bins");
});

describe("POST /bins with X-Bin-Private", () => {
  it("creates a Private Bin and issues a readKey", async () => {
    const { res, body } = await createPrivateBin();

    expect(Object.keys(body).sort()).toEqual(["createdAt", "expiresAt", "id", "private", "readKey", "writeKey"]);
    expect(body.readKey).toMatch(/^kj_r_[A-Za-z0-9_-]{43}$/);
    expect(body.writeKey).toMatch(/^kj_w_/);
    expect(body.private).toBe(true);
    expect(res.headers.get("X-Bin-Private")).toBe("true");
  });

  it("stores only the hash of the readKey", async () => {
    const { body } = await createPrivateBin();
    const readKey = body.readKey ?? "";

    const stored = await findLive(env.DB, body.id, Date.now());
    expect(stored?.isPrivate).toBe(true);
    expect(stored?.readKeyHash).toBe(await hashKey(readKey));
    expect(stored?.writeKeyHash).toBe(await hashKey(body.writeKey));

    const row = await env.DB.prepare("SELECT * FROM bins WHERE id = ?").bind(body.id).first();
    expect(row?.is_private).toBe(1);
    for (const value of Object.values(row ?? {})) {
      for (const key of [readKey, body.writeKey]) {
        expect(String(value)).not.toContain(key);
        expect(String(value)).not.toContain(key.slice("kj_r_".length));
      }
    }
  });

  it("issues a different readKey for each Private Bin", async () => {
    const { body: a } = await createPrivateBin();
    const { body: b } = await createPrivateBin();
    expect(a.readKey).not.toBe(b.readKey);
  });

  it.each(["TRUE", "True", " true "])("treats %j as true", async (value) => {
    const { body } = await createBin("{}", { "X-Bin-Private": value });
    expect(body.private).toBe(true);
    expect(body.readKey).toMatch(/^kj_r_/);
  });

  it("creates a public Bin without the header", async () => {
    const { res, body } = await createBin("{}");

    expect(body).not.toHaveProperty("readKey");
    expect(body.private).toBe(false);
    expect(res.headers.get("X-Bin-Private")).toBe("false");

    const row = await env.DB.prepare("SELECT is_private, read_key_hash FROM bins WHERE id = ?").bind(body.id).first();
    expect(row).toEqual({ is_private: 0, read_key_hash: null });
  });

  it.each(["false", "", "1", "yes", "on", "truthy", "true, true"])(
    "creates a public Bin for X-Bin-Private: %j",
    async (value) => {
      const { res, body } = await createBin("{}", { "X-Bin-Private": value });

      expect(body).not.toHaveProperty("readKey");
      expect(body.private).toBe(false);
      expect(res.headers.get("X-Bin-Private")).toBe("false");
      expect((await findLive(env.DB, body.id, Date.now()))?.readKeyHash).toBeNull();
    },
  );
});

describe("GET /bins/:id on a Private Bin", () => {
  it("returns 401 without a key", async () => {
    const { body } = await createPrivateBin();
    await expectError(await getBin(body.id), 401, "unauthorized");
  });

  it.each([
    ["a non-Bearer scheme", (key: string) => `Basic ${key}`],
    ["a bare key", (key: string) => key],
    ["Bearer with an empty key", () => "Bearer "],
    ["Bearer with only spaces", () => "Bearer    "],
    ["Bearer alone", () => "Bearer"],
    ["an empty header", () => ""],
  ])("returns 401 for %s", async (_name, authorization) => {
    const { body } = await createPrivateBin();
    await expectError(await getBin(body.id, authorization(body.readKey ?? "")), 401, "unauthorized");
  });

  it.each([
    ["a random string", () => "Bearer not-a-key"],
    ["a made-up Read Key", () => `Bearer ${generateReadKey()}`],
    ["a made-up Write Key", () => `Bearer ${generateWriteKey()}`],
  ])("returns 403 for %s", async (_name, authorization) => {
    const { body } = await createPrivateBin();
    await expectError(await getBin(body.id, authorization()), 403, "forbidden");
  });

  it("returns 403 for the Read Key of a different Private Bin", async () => {
    const { body: mine } = await createPrivateBin();
    const { body: other } = await createPrivateBin();
    await expectError(await getBin(mine.id, `Bearer ${other.readKey}`), 403, "forbidden");
  });

  it("returns 403 for the Write Key of a different Bin", async () => {
    const { body: mine } = await createPrivateBin();
    const { body: other } = await createBin("{}");
    await expectError(await getBin(mine.id, `Bearer ${other.writeKey}`), 403, "forbidden");
  });

  it("returns the content for the Read Key", async () => {
    const content = '{ "secret" : [1, 2] }';
    const { body } = await createPrivateBin(content);

    const res = await getBin(body.id, `Bearer ${body.readKey}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("X-Bin-Id")).toBe(body.id);
    expect(res.headers.get("X-Bin-Private")).toBe("true");
    expect(await res.text()).toBe(content);
  });

  it("returns the content for the Write Key", async () => {
    const content = "[ true ]";
    const { body } = await createPrivateBin(content);

    const res = await getBin(body.id, `Bearer ${body.writeKey}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
  });

  it("accepts the scheme in any case", async () => {
    const { body } = await createPrivateBin();
    expect((await getBin(body.id, `bearer ${body.readKey}`)).status).toBe(200);
    expect((await getBin(body.id, `BEARER ${body.writeKey}`)).status).toBe(200);
  });

  it("never sends a key back", async () => {
    const { body } = await createPrivateBin();
    const res = await getBin(body.id, `Bearer ${body.readKey}`);
    const text = await res.text();
    for (const key of [body.readKey ?? "", body.writeKey]) {
      expect(text).not.toContain(key);
      for (const [, value] of res.headers) expect(value).not.toContain(key);
    }
  });

  it("returns 404 for an unknown or malformed id before checking auth", async () => {
    await expectError(await getBin("V1StGXR8_Z5jdHi6B-myT"), 404, "not_found");
    await expectError(await getBin("malformed", "Bearer kj_r_nope"), 404, "not_found");
  });
});

describe("GET /bins/:id on a public Bin", () => {
  it.each([
    ["a random Bearer key", "Bearer not-a-key"],
    ["a made-up Read Key", `Bearer ${generateReadKey()}`],
    ["a non-Bearer scheme", "Basic dXNlcjpwYXNz"],
    ["an empty Bearer key", "Bearer "],
    ["garbage", "!!garbage!!"],
  ])("ignores %s in Authorization", async (_name, authorization) => {
    const { body } = await createBin('{"a": 1}');

    const res = await getBin(body.id, authorization);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"a": 1}');
  });
});
