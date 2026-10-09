# keepjson API contract (MVP)

This is what the MVP implements. Terms (Bin, Write Key, Read Key, Private Bin, Expiry, Instance) are defined in [`CONTEXT.md`](../CONTEXT.md). The reasons behind the shape are in [`docs/adr/`](./adr/). Changing this contract means updating this file in the same commit.

## Conventions

- Bin bodies are raw JSON, with no envelope. Bin metadata goes in `X-Bin-*` response headers.
- Timestamps in headers and JSON are ISO 8601 UTC (`2026-10-09T12:00:00.000Z`).
- Every response sends `Cache-Control: no-store` (last write wins, so caches would serve stale content).
- Auth is `Authorization: Bearer <key>`.
- Error responses always have this shape:

  ```json
  { "error": { "code": "not_found", "message": "Bin not found" } }
  ```

## Routes

### `GET /health`
`200 {"status":"ok"}`. Needs no auth and doesn't touch D1.

### `POST /bins`: create a Bin

| Request header | Meaning |
|---|---|
| `Content-Type: application/json` | Required. Anything else → `415 unsupported_media_type`. |
| `X-Bin-Private: true` | Optional. Makes a Private Bin and issues a Read Key. Fixed at creation. Only `true` (any case, surrounding whitespace ignored) does this; any other value makes a public Bin. |
| `X-Bin-TTL: <seconds>` | Optional positive integer. Sets the Expiry to `now + TTL`. See [Expiry rules](#expiry-rules). |

Body: the JSON to store. It must be an object or an array (empty is allowed).

Response `201`, `Location: /bins/<id>`, metadata headers, and this body:

```json
{
  "id": "V1StGXR8_Z5jdHi6B-myT",
  "writeKey": "kj_w_…",
  "readKey": "kj_r_…",
  "private": true,
  "createdAt": "2026-10-09T12:00:00.000Z",
  "expiresAt": null
}
```

`readKey` is present only for Private Bins. Keys are shown only once.

### `GET /bins/:id`: read a Bin

- Public Bin: no auth needed.
- Private Bin: needs the Read Key or the Write Key. No key → `401 unauthorized`. A wrong key → `403 forbidden`.
- Response `200`, `Content-Type: application/json; charset=utf-8`, metadata headers. The body is the stored JSON byte-for-byte as last written.

### `PUT /bins/:id`: replace a Bin's content

- Needs the Write Key (`401` without a key; `403` with a wrong key or a Read Key).
- Body rules are the same as `POST /bins`. Last write wins: there is no concurrency check.
- Privacy and Expiry don't change. `X-Bin-Private` and `X-Bin-TTL` are ignored on PUT in the MVP.
- Response `200`, metadata headers, and this body: `{"id","private","createdAt","updatedAt","expiresAt"}`.

### `DELETE /bins/:id`: delete a Bin

- Needs the Write Key. Response `204`. The Bin is gone immediately and permanently.

### Not in the MVP, deliberately
There is no listing endpoint (ADR 0002), and no PATCH, ETag/If-Match, version history or key rotation. See `docs/TODO.md` → Future.

## Metadata response headers

| Header | Value |
|---|---|
| `X-Bin-Id` | id |
| `X-Bin-Private` | `true` / `false` |
| `X-Bin-Created-At` | ISO timestamp |
| `X-Bin-Updated-At` | ISO timestamp |
| `X-Bin-Expires-At` | ISO timestamp. Left out when the Bin has no Expiry. |

Browsers can read all of these via `Access-Control-Expose-Headers`, along with `Location`.

## Validation and errors

Check in this order: rate limit (`POST`, `PUT`, `DELETE`) → route/id → auth (non-create routes) → `X-Bin-TTL` (create only) → content type → size → JSON parse → top-level type. The rate limit comes first because it protects the Worker: a limited client gets no D1 lookup, key check or body parsing. `X-Bin-TTL` is a header, so a bad one is rejected before any of the body is read.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_json` | Body isn't valid JSON |
| 400 | `invalid_ttl` | `X-Bin-TTL` isn't a positive integer, or is larger than the Instance's maximum TTL |
| 401 | `unauthorized` | A key is needed and none was sent |
| 403 | `forbidden` | The key sent doesn't grant this action |
| 404 | `not_found` | Unknown id, malformed id, or an expired Bin (these can't be told apart) |
| 413 | `payload_too_large` | Body bytes > `MAX_BIN_BYTES`. Check `Content-Length` first, then the actual bytes. |
| 415 | `unsupported_media_type` | `Content-Type` isn't `application/json` |
| 422 | `invalid_top_level` | Valid JSON, but not an object or array |
| 429 | `rate_limited` | Rate limit exceeded. Send `Retry-After`. |
| 500 | `internal_error` | An unexpected server error. The details are not returned or logged, since a request can carry keys. |

## Ids and keys

- **Bin id:** `nanoid()` with the default 21-character URL-safe alphabet (about 126 bits). Validate it with `^[A-Za-z0-9_-]{21}$`; anything else gets `404`.
- **Write Key:** `kj_w_` + 32 random bytes in base64url. **Read Key:** `kj_r_` + 32 random bytes in base64url. The prefixes let secret scanners spot leaked keys and let the server tell the key types apart.
- Store `hex(SHA-256(key))` only; a slow hash isn't needed because the keys are high-entropy. Compare hashes in constant time.
- Never log keys, and never return them after the `201`.

## Expiry rules

Instance variables: `DEFAULT_TTL_SECONDS` and `MAX_TTL_SECONDS`. `0` or unset means no default or no maximum.

1. If `X-Bin-TTL` is sent and is `≤ MAX_TTL_SECONDS` (or there is no maximum), Expiry = `now + TTL`. If it's above the maximum → `400 invalid_ttl`. The value must be ASCII digits only (surrounding whitespace ignored): no sign, decimal point or exponent, not `0`, and not empty. A TTL too large to be an exact integer, or one that puts the Expiry past the latest representable timestamp, is also `400 invalid_ttl`.
2. With no header: if a default is set, use it; otherwise, if a maximum is set, use the maximum; otherwise the Bin never expires.
3. Requests check whether the Bin has expired (`expires_at <= now` → `404`), so a Bin is never served after its Expiry even before it is deleted.
4. An hourly Cron Trigger (`0 * * * *`) deletes expired rows in batches (`LIMIT 500` per statement, looping until none are left or the time budget runs out).

## Rate limiting

Two Workers Rate Limiting bindings, keyed on `CF-Connecting-IP`:
- `CREATE_LIMITER` for `POST /bins`
- `WRITE_LIMITER` for `PUT` and `DELETE`

Reads have no limit in the MVP. Setting `RATE_LIMIT_ENABLED=false` turns both off. The binding's period can only be 10 s or 60 s.

- Over the limit → `429 rate_limited` with `Retry-After: <seconds>`. A binding can't report when its window resets, so `Retry-After` is the binding's whole period (60 s).
- Requests without `CF-Connecting-IP` (Cloudflare always sends it) share a single bucket, keyed `unknown`, rather than going unlimited.

## CORS

`CORS_ORIGINS` is `*` (the default) or a comma-separated allowlist. Allowed methods: `GET, POST, PUT, DELETE, OPTIONS`. Allowed headers: `Authorization, Content-Type, X-Bin-Private, X-Bin-TTL`. The docs must warn that a Write Key embedded in frontend code gives every visitor write access.

## Instance configuration (`vars`)

| Var | Default | Demo Instance |
|---|---|---|
| `MAX_BIN_BYTES` | `102400` | `102400` |
| `DEFAULT_TTL_SECONDS` | `0` (none) | `2592000` (30 d) |
| `MAX_TTL_SECONDS` | `0` (none) | `2592000` |
| `CORS_ORIGINS` | `*` | `*` |
| `RATE_LIMIT_ENABLED` | `true` | `true` |

`MAX_BIN_BYTES` must not be set above about 1,000,000 (the D1 row cap is about 2 MB, ADR 0003). Reject such a value when the config is parsed at startup.

## Storage (draft schema, `migrations/0001_bins.sql`)

```sql
CREATE TABLE bins (
  id             TEXT PRIMARY KEY,
  content        TEXT    NOT NULL,             -- raw JSON as received
  is_private     INTEGER NOT NULL DEFAULT 0,   -- 0/1
  write_key_hash TEXT    NOT NULL,             -- hex sha-256
  read_key_hash  TEXT,                         -- NULL unless private
  created_at     INTEGER NOT NULL,             -- unix ms
  updated_at     INTEGER NOT NULL,             -- unix ms
  expires_at     INTEGER                       -- unix ms, NULL = never
);
CREATE INDEX bins_expires_at ON bins (expires_at) WHERE expires_at IS NOT NULL;
```

All SQL lives in one repository module (`src/bins/repository.ts`). Route handlers never build SQL themselves.
