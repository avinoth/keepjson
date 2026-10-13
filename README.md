# keepjson

Store JSON with one HTTP call. No signup, no account, no SDK.

Demo Instance 👉 [https://keepjson.fourlegs.workers.dev](https://keepjson.fourlegs.workers.dev)

An open-source alternative to [jsonbin.io](https://jsonbin.io) that you deploy to your own Cloudflare account, built on Hono, Cloudflare Workers and D1.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/avinoth/keepjson)

The button deploys the Worker to your Cloudflare account. After a one-click deploy you still need to run the D1 migrations, or every Bin request fails because the `bins` table doesn't exist yet: see [`Deployment Instructions`](./docs/deploy.md).

## Quick start

Every example uses `BASE`, the URL of your Instance (`http://localhost:8787` under `pnpm dev`):

```sh
BASE=https://keepjson.<your-subdomain>.workers.dev
```

### Create a Bin

The body must be a JSON object or array, sent with `Content-Type: application/json`.

```sh
curl -i -X POST "$BASE/bins" \
  -H 'Content-Type: application/json' \
  -d '{"hello":"world"}'
```

```http
HTTP/1.1 201 Created
Location: /bins/LfPSR7g3LQUoBve1utAKk
X-Bin-Id: LfPSR7g3LQUoBve1utAKk
X-Bin-Private: false
X-Bin-Created-At: 2026-10-09T12:00:00.000Z
X-Bin-Updated-At: 2026-10-09T12:00:00.000Z
Cache-Control: no-store

{"id":"LfPSR7g3LQUoBve1utAKk","writeKey":"kj_w_3mQ…","private":false,"createdAt":"2026-10-09T12:00:00.000Z","expiresAt":null}
```

Save the `writeKey` now: it is shown only once, and the server keeps only its hash, so a lost Write Key can't be recovered. Save the `id` as well to access the bin later.

```sh
ID=LfPSR7g3LQUoBve1utAKk
WRITE_KEY='kj_w_3mQ…'  # paste the whole writeKey from the response (keys are shortened with … in this README)
```

### Read it

A public Bin needs no key. You get back exactly the JSON you stored, byte for byte, with the Bin's metadata in `X-Bin-*` headers.

```sh
curl -i "$BASE/bins/$ID"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Bin-Id: LfPSR7g3LQUoBve1utAKk
X-Bin-Private: false
X-Bin-Created-At: 2026-10-09T12:00:00.000Z
X-Bin-Updated-At: 2026-10-09T12:00:00.000Z
Cache-Control: no-store

{"hello":"world"}
```

### Replace it

Replacing needs the Write Key. The whole content is replaced, and the last write wins.

```sh
curl -i -X PUT "$BASE/bins/$ID" \
  -H "Authorization: Bearer $WRITE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"hello":"again"}'
```

```http
HTTP/1.1 200 OK
X-Bin-Id: LfPSR7g3LQUoBve1utAKk
X-Bin-Private: false
X-Bin-Created-At: 2026-10-09T12:00:00.000Z
X-Bin-Updated-At: 2026-10-09T12:05:00.000Z

{"id":"LfPSR7g3LQUoBve1utAKk","private":false,"createdAt":"2026-10-09T12:00:00.000Z","updatedAt":"2026-10-09T12:05:00.000Z","expiresAt":null}
```

### Delete it

Deleting needs the Write Key too. The Bin is gone at once, and for good.

```sh
curl -i -X DELETE "$BASE/bins/$ID" -H "Authorization: Bearer $WRITE_KEY"
```

```http
HTTP/1.1 204 No Content
```

### Private Bins

Send `X-Bin-Private: true` on create to make a Private Bin. Its content can be read only with a key, and the response also gives you a **Read Key** (`kj_r_…`), which can read the Bin but not change it.

```sh
curl -i -X POST "$BASE/bins" \
  -H 'Content-Type: application/json' \
  -H 'X-Bin-Private: true' \
  -d '{"score":42}'
```

```http
HTTP/1.1 201 Created
Location: /bins/T9r8GR7iHMLh3crwtm52w
X-Bin-Id: T9r8GR7iHMLh3crwtm52w
X-Bin-Private: true
X-Bin-Created-At: 2026-10-09T12:00:00.000Z
X-Bin-Updated-At: 2026-10-09T12:00:00.000Z

{"id":"T9r8GR7iHMLh3crwtm52w","writeKey":"kj_w_b8L…","readKey":"kj_r_Zp2…","private":true,"createdAt":"2026-10-09T12:00:00.000Z","expiresAt":null}
```

You can read it with either the Read Key or the Write Key:

```sh
READ_KEY='kj_r_Zp2…'  # the whole readKey from the response
curl "$BASE/bins/T9r8GR7iHMLh3crwtm52w" -H "Authorization: Bearer $READ_KEY"
# → 200 {"score":42}
```

Without a key you get `401`; with a wrong key, or a Read Key on `PUT` or `DELETE`, you get `403`:

```http
HTTP/1.1 401 Unauthorized

{"error":{"code":"unauthorized","message":"This Bin needs a key: send Authorization: Bearer <key>"}}
```

### Expiry

Send `X-Bin-TTL: <seconds>` on create and the Bin expires that many seconds later. The Expiry comes back in `expiresAt` and in the `X-Bin-Expires-At` header.

```sh
curl -i -X POST "$BASE/bins" \
  -H 'Content-Type: application/json' \
  -H 'X-Bin-TTL: 86400' \
  -d '[1,2,3]'
```

```http
HTTP/1.1 201 Created
Location: /bins/P159twtqmCe98Lc4dKigT
X-Bin-Id: P159twtqmCe98Lc4dKigT
X-Bin-Private: false
X-Bin-Created-At: 2026-10-09T12:00:00.000Z
X-Bin-Updated-At: 2026-10-09T12:00:00.000Z
X-Bin-Expires-At: 2026-10-10T12:00:00.000Z

{"id":"P159twtqmCe98Lc4dKigT","writeKey":"kj_w_t4R…","private":false,"createdAt":"2026-10-09T12:00:00.000Z","expiresAt":"2026-10-10T12:00:00.000Z"}
```

The TTL must be a positive integer of seconds, and not above the Instance's maximum. An Instance can also set a default TTL for Bins created without the header. The Expiry can't be changed after creation.

### Errors

Every error has the same shape:

```http
HTTP/1.1 400 Bad Request

{"error":{"code":"invalid_ttl","message":"X-Bin-TTL must be a positive integer of seconds"}}
```

The codes are `invalid_json`, `invalid_ttl` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `payload_too_large` (413), `unsupported_media_type` (415), `invalid_top_level` (422), `rate_limited` (429, with `Retry-After`) and `internal_error` (500). Creating, replacing and deleting are rate limited per client IP; reading is not.

> [!WARNING]
> **Never put a Write Key in frontend code.** Anything shipped to a browser (JavaScript, HTML, a mobile app bundle) can be read by everyone who loads it. Anyone who can see the page can copy the Write Key and overwrite or delete the Bin. For a read-only frontend, use a public Bin (no key at all) or a Private Bin's Read Key, which can only read. Keep the Write Key on a server or in a script only you run.

## API reference

- `GET /docs` on any Instance serves an interactive API reference (Swagger UI).
- `GET /openapi.json` serves the OpenAPI 3.1 spec, for client generators and other tools.

## Deploy your own Instance

keepjson runs in your own Cloudflare account: you deploy it there with your own D1 database, and you set the limits (Bin size, Expiry, rate limits, CORS origins). [`Deployment Instructions`](./docs/deploy.md) walks through creating the D1 database, running the migrations, setting the vars, deploying and updating.

### Deploy with a coding agent

Point your coding agent (Claude Code, Codex, Cursor, …) at this repo and ask it to deploy keepjson, for example:

> Deploy keepjson to my Cloudflare account, following `docs/deploy.md`.

[`AGENTS.md`](./AGENTS.md) tells the agent to follow `docs/deploy.md`, to ask you before it creates or changes anything in your account, and to leave `wrangler login` to you. You still need a Cloudflare account.

## Docs

- [`CONTEXT.md`](./CONTEXT.md): domain vocabulary
- [`docs/deploy.md`](./docs/deploy.md): deploying and running your own Instance
- [`AGENTS.md`](./AGENTS.md): how coding agents (and humans) should work on this repo

## License

[MIT](./LICENSE)
