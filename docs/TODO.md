# keepjson TODO

Do these in order. Each task is a thin end-to-end slice: test first, implement, tick the box, then commit, raise a PR. The contract is in [`api.md`](./api.md), the vocabulary in [`../CONTEXT.md`](../CONTEXT.md). A task is done only when every acceptance criterion is ticked and `pnpm check` (typecheck + lint + test) passes.

---

## 0. Scaffold
- [x] `package.json` (pnpm, `"type": "module"`), with scripts `dev`, `deploy`, `test`, `typecheck`, `lint`, `format`, `check`, `db:migrate:local`
- [x] TypeScript strict; `wrangler types` (`pnpm typegen`) for the `Env` type
- [x] Dependencies: `hono`, `@hono/zod-openapi`, `zod`, `nanoid`; dev: `wrangler`, `vitest`, `@cloudflare/vitest-plugin` (the renamed `@cloudflare/vitest-pool-workers`), `@biomejs/biome`, `typescript`
- [x] `wrangler.jsonc` with: D1 binding `DB`, `migrations_dir: "migrations"`, rate-limit bindings `CREATE_LIMITER` / `WRITE_LIMITER`, cron trigger `0 * * * *`, and the `vars` from api.md → Instance configuration
- [x] `src/index.ts` exports `{ fetch, scheduled }`, using an `OpenAPIHono` app
- [x] `src/config.ts` parses `vars` into a typed config with zod (defaults applied; rejects `MAX_BIN_BYTES > 1_000_000`)
- [x] `GET /health` → `200 {"status":"ok"}`
- [x] Vitest with the pool-workers config; one test covering `/health` and one covering config parsing
- [x] `biome.json`; `.github/workflows/ci.yml` running `pnpm install --frozen-lockfile && pnpm check` on push/PR

**Done when:** `pnpm check` passes from a fresh clone and `pnpm dev` serves `/health`.

## 1. Schema and repository
- [x] `migrations/0001_bins.sql` exactly as drafted in api.md → Storage
- [x] Tests apply the migrations to the local D1 (via `applyD1Migrations` in the vitest setup)
- [x] `src/bins/repository.ts`: `insert`, `findLive(id, now)` (leaves out expired Bins), `replaceContent`, `remove`, `deleteExpired(now, limit)`
- [x] `src/bins/keys.ts`: generate Write/Read Keys and ids, `hashKey`, constant-time `matches`
- [x] Unit tests: the repository against real local D1; key format/prefix/hash; `findLive` doesn't return an expired row

## 2. Create a Bin, `POST /bins`
- [x] Validation pipeline as in api.md (415 → 413 → 400 → 422), with a reusable `parseBinBody(request, config)`
- [x] Returns `201` with `Location`, metadata headers and the documented JSON body; `writeKey` matches `^kj_w_`
- [x] Only the key hash is stored (a test checks that the row contains no plaintext key)
- [x] Tests: happy path (object and array, including empty), each error code, a body exactly at the limit and one byte over

## 3. Read a public Bin, `GET /bins/:id`
- [x] Returns the stored body byte-for-byte, `Content-Type: application/json; charset=utf-8`, metadata headers, `Cache-Control: no-store`
- [x] `404 not_found` for an unknown id and for a malformed id
- [x] Tests: round trip create → read (content, whitespace and key order preserved), 404 cases

## 4. Private Bins
- [x] `X-Bin-Private: true` on create → `readKey` (`kj_r_…`) in the response, its hash stored, `private: true`
- [x] GET on a Private Bin: no key → 401; wrong key → 403; Read Key → 200; Write Key → 200
- [x] A public Bin ignores any `Authorization` header on GET
- [x] Tests for every case above

## 5. Replace a Bin, `PUT /bins/:id`
- [x] Needs the Write Key; a Read Key → 403; no key → 401; unknown → 404
- [x] Same body validation as create; `updated_at` changes, while `created_at`, privacy and Expiry stay the same
- [x] Response `200` with the metadata body and headers
- [x] Tests: replace then read returns the new content; `X-Bin-Private`/`X-Bin-TTL` on PUT are ignored

## 6. Delete a Bin, `DELETE /bins/:id`
- [x] Needs the Write Key; `204`; a later GET → 404
- [x] Tests: auth cases; deleting twice → second call 404

## 7. Expiry
- [x] `X-Bin-TTL` handling and the default/max rules exactly as in api.md → Expiry rules
- [x] An expired Bin returns 404 on GET/PUT/DELETE, even before the sweep runs
- [x] `scheduled` handler: loops `deleteExpired(now, 500)` until nothing is left or about 20 s have passed
- [x] `X-Bin-Expires-At` is sent when the Bin has an Expiry
- [x] Tests: each TTL rule, invalid TTLs, a lazy 404 with a faked clock, the sweep deleting only expired rows

## 8. Rate limiting
- [x] Middleware applies `CREATE_LIMITER` to POST and `WRITE_LIMITER` to PUT/DELETE, keyed on `CF-Connecting-IP`
- [x] Over the limit → `429 rate_limited` + `Retry-After`; `RATE_LIMIT_ENABLED=false` skips the check
- [x] Tests: use a stub limiter binding to check both branches and the disabled flag

## 9. CORS
- [x] Hono `cors()` driven by `CORS_ORIGINS` (`*` or an allowlist); methods, allowed headers and exposed headers as in api.md
- [x] Tests: preflight on `/bins` and `/bins/:id`; a disallowed origin gets no ACAO header; `X-Bin-*` headers are exposed

## 10. OpenAPI
- [x] Every route is defined with `createRoute` (request headers, bodies and all error responses described)
- [x] `GET /openapi.json` serves the spec; `GET /docs` serves a Swagger UI or Scalar page
- [x] Test: the spec is valid and lists every route in api.md

## 11. Deployment docs and demo
- [x] README: quick start with curl examples (create/read/replace/delete, private, TTL); a "Deploy to Cloudflare" button
- [x] `docs/deploy.md` (deploying to your own Cloudflare account): create the D1 database, run migrations, set vars, deploy, update
- [x] The README warns about putting Write Keys in frontend code
- [x] A `demo` environment in `wrangler.jsonc` with the demo Instance values from api.md
