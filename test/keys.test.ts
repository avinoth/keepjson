import { describe, expect, it } from "vitest";
import { generateBinId, generateReadKey, generateWriteKey, hashKey, isValidBinId, matches } from "../src/bins/keys";

// 32 bytes in base64url without padding is 43 characters.
const KEY_BODY = /^[A-Za-z0-9_-]{43}$/;

describe("generateBinId", () => {
  it("returns a valid 21-character URL-safe id", () => {
    const id = generateBinId();
    expect(id).toHaveLength(21);
    expect(isValidBinId(id)).toBe(true);
  });

  it("returns a different id each time", () => {
    expect(generateBinId()).not.toBe(generateBinId());
  });
});

describe("isValidBinId", () => {
  it.each([
    ["V1StGXR8_Z5jdHi6B-myT", true],
    ["V1StGXR8_Z5jdHi6B-my", false],
    ["V1StGXR8_Z5jdHi6B-myTx", false],
    ["V1StGXR8_Z5jdHi6B-my.", false],
    ["", false],
  ])("%s → %s", (id, valid) => {
    expect(isValidBinId(id)).toBe(valid);
  });
});

describe("generateWriteKey / generateReadKey", () => {
  it("prefixes a writeKey with kj_w_ and 32 random bytes in base64url", () => {
    const writeKey = generateWriteKey();
    expect(writeKey.startsWith("kj_w_")).toBe(true);
    expect(writeKey.slice(5)).toMatch(KEY_BODY);
  });

  it("prefixes a readKey with kj_r_ and 32 random bytes in base64url", () => {
    const readKey = generateReadKey();
    expect(readKey.startsWith("kj_r_")).toBe(true);
    expect(readKey.slice(5)).toMatch(KEY_BODY);
  });

  it("returns a different key each time", () => {
    expect(generateWriteKey()).not.toBe(generateWriteKey());
    expect(generateReadKey()).not.toBe(generateReadKey());
  });
});

describe("hashKey", () => {
  it("returns the hex SHA-256 of the key", async () => {
    expect(await hashKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("matches", () => {
  it("is true for the key whose hash is stored", async () => {
    const writeKey = generateWriteKey();
    expect(await matches(writeKey, await hashKey(writeKey))).toBe(true);
  });

  it("is false for any other key", async () => {
    const writeKey = generateWriteKey();
    const expectedHash = await hashKey(writeKey);
    expect(await matches(generateWriteKey(), expectedHash)).toBe(false);
    expect(await matches(generateReadKey(), expectedHash)).toBe(false);
    expect(await matches("", expectedHash)).toBe(false);
  });

  it("is false for a malformed stored hash", async () => {
    const writeKey = generateWriteKey();
    expect(await matches(writeKey, "")).toBe(false);
    expect(await matches(writeKey, "zz")).toBe(false);
  });
});
