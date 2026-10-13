# Deploy keepjson to your own Cloudflare account

An Instance of keepjson is one Cloudflare Worker plus one D1 database in your own Cloudflare account. This guide sets one up from a clone, then covers configuration, local development, updates and the demo environment.

## Prerequisites

- A Cloudflare account. The Worker, D1, Cron Triggers and the Workers Rate Limiting bindings all run on it.
- Node.js 22 and pnpm.
- Wrangler, Cloudflare's CLI, is a dev dependency, so you run it as `pnpm exec wrangler` and don't need a global install. Log in once:

  ```sh
  pnpm exec wrangler login
  ```

## 1. Clone and install

```sh
git clone https://github.com/avinoth/keepjson.git
cd keepjson
pnpm install
```

## 2. Create the D1 database

```sh
pnpm exec wrangler d1 create keepjson
```

The command prints the new database's `database_id`. Put it into `wrangler.jsonc`, replacing the all-zero placeholder in the top-level `d1_databases` entry:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "keepjson",
    "database_id": "<the id printed above>",
    "migrations_dir": "migrations"
  }
],
```

Keep `binding` as `DB` and `migrations_dir` as `migrations`: the code and the commands below rely on them.

## 3. Run the migrations

The migrations in `migrations/` create the `bins` table. Apply them to the remote database before the first deploy:

```sh
pnpm exec wrangler d1 migrations apply keepjson --remote
```

Wrangler lists the migrations it is about to apply and asks you to confirm. It applies only the ones the database hasn't had yet, so the same command is safe to rerun. The argument is the database name or its binding, so `pnpm exec wrangler d1 migrations apply DB --remote` works too.

For local development, apply them to the local database as well (see [Local development](#local-development)):

```sh
pnpm db:migrate:local
```

## 4. Set the vars

An Instance is configured through the `vars` in `wrangler.jsonc`. Every value is a string. An empty or missing var takes its default.

| Var | Default | Meaning |
|---|---|---|
| `MAX_BIN_BYTES` | `102400` (100 KiB) | The largest body, in bytes, that `POST` and `PUT` accept. A larger one gets `413 payload_too_large`. A positive integer, at most `1000000`. |
| `DEFAULT_TTL_SECONDS` | `0` (none) | The TTL of a Bin created without `X-Bin-TTL`. `0` means no default. |
| `MAX_TTL_SECONDS` | `0` (none) | The largest TTL a Bin can have. `0` means no maximum. |
| `CORS_ORIGINS` | `*` | The browser origins allowed to call the Instance: `*`, or a comma-separated allowlist. |
| `RATE_LIMIT_ENABLED` | `true` | `false` turns off rate limiting for `POST`, `PUT` and `DELETE`. Only `true` or `false`. |

**Why `MAX_BIN_BYTES` stops at 1,000,000.** Each Bin's content is stored inline in its D1 row, and D1 caps a row at about 2 MB. The ceiling leaves headroom for the rest of the row. Bins larger than that need a different storage layer.

**Expiry.** `DEFAULT_TTL_SECONDS` and `MAX_TTL_SECONDS` work together:

- With `X-Bin-TTL` on create, the Bin expires that many seconds later. A TTL above `MAX_TTL_SECONDS` (when it isn't `0`) is rejected with `400 invalid_ttl`.
- Without the header, the Bin gets `DEFAULT_TTL_SECONDS`; if that is `0`, it gets `MAX_TTL_SECONDS`; if that is `0` too, it never expires.
- So setting only `MAX_TTL_SECONDS` puts an upper bound on every Bin, which is the way to keep a public Instance's database from growing without end. Keep `DEFAULT_TTL_SECONDS` at or below `MAX_TTL_SECONDS`.
- The Expiry is fixed when a Bin is created: changing these vars later doesn't change existing Bins.

**`CORS_ORIGINS`.** `*` lets any web page call the Instance from a browser. An allowlist is a comma-separated list of exact origins (scheme, host and port if not the default, no path and no trailing slash), for example `https://app.example.com,https://admin.example.com`; whitespace around each entry is ignored, and wildcards such as `https://*.example.com` aren't supported. A request whose `Origin` doesn't match an entry gets no `Access-Control-Allow-Origin`, so the browser blocks it. CORS only restricts browsers: it doesn't stop `curl` or a server from calling the Instance, and an empty value means `*`.

**`RATE_LIMIT_ENABLED`.** Leave it `true` on any Instance reachable from the internet. `false` is meant for private Instances, such as one behind Cloudflare Access.

A var that doesn't parse (for example `MAX_BIN_BYTES` above `1000000`, or `RATE_LIMIT_ENABLED=yes`) makes the Instance answer every request with `500 internal_error`. Check the values after editing them.

If you change `vars` or bindings, run `pnpm typegen` to regenerate `worker-configuration.d.ts`.

## 5. Configure the rate limits

`POST /bins` is limited by the `CREATE_LIMITER` binding and `PUT`/`DELETE` by `WRITE_LIMITER`, per client IP. Reads aren't limited. They are set in `wrangler.jsonc`:

```jsonc
"ratelimits": [
  { "name": "CREATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 10, "period": 60 } },
  { "name": "WRITE_LIMITER", "namespace_id": "1002", "simple": { "limit": 60, "period": 60 } }
],
```

- `limit` is the number of requests a single IP may make per `period`. Change it freely.
- `namespace_id` must be unique per rate limiter within your Cloudflare account. If the account already has rate limiters with `1001` or `1002`, pick other numbers, or the Workers would share their counters.
- `period` can only be `10` or `60` seconds. A binding can't report when its window resets, so a `429` sends the whole period as `Retry-After`. That number comes from `RATE_LIMIT_PERIOD_SECONDS` in [`src/bins/rate-limit.ts`](../src/bins/rate-limit.ts), which is shared by both bindings. If you change `period`, change it on both bindings and set `RATE_LIMIT_PERIOD_SECONDS` to the same value.

## 6. The hourly sweep

Expired Bins answer `404` as soon as their Expiry passes. Their rows are deleted by a Cron Trigger that runs every hour:

```jsonc
"triggers": { "crons": ["0 * * * *"] },
```

`wrangler deploy` registers it; there is nothing else to set up. Each run deletes expired Bins in batches of 500 for up to about 20 seconds, and whatever is left goes to the next run. You can see the runs, and how many Bins each deleted, in the Worker's logs in the Cloudflare dashboard.

## 7. Deploy

```sh
pnpm run deploy
```

Use `pnpm run deploy`, not `pnpm deploy`: `pnpm deploy` is a built-in pnpm command and doesn't run the script. The script runs `wrangler deploy`, which uploads the Worker as `keepjson` and prints its URL (`https://keepjson.<your-subdomain>.workers.dev`). Wrangler warns that several environments are defined and none was chosen; that is expected, and it deploys the top-level configuration. To use your own domain, add a route or custom domain in the Cloudflare dashboard or in `wrangler.jsonc`.

Check the Instance:

```sh
curl https://keepjson.<your-subdomain>.workers.dev/health
# → {"status":"ok"}
```

The API reference is served at `/docs` and the OpenAPI spec at `/openapi.json`. The [README](../README.md#quick-start) has curl examples for every route.

### With the Deploy to Cloudflare button

The button in the README copies the repo to your GitHub account, creates the Worker and its resources, and deploys it. It doesn't run the D1 migrations, so the `bins` table doesn't exist yet and every Bin request fails with `500 internal_error`. Clone the new repo, then run step 3 against it:

```sh
pnpm install
pnpm exec wrangler login
pnpm exec wrangler d1 migrations apply DB --remote
```

Using the binding `DB` here works whatever name the database was given during the deploy.

## Local development

```sh
pnpm install
pnpm db:migrate:local   # creates the bins table in the local D1 database, under .wrangler/
pnpm dev                # serves the Instance on http://localhost:8787
```

`pnpm dev` uses the top-level configuration with a local D1 database and simulated rate limiters; it doesn't touch your Cloudflare account. To override vars locally without editing `wrangler.jsonc`, put them in a `.dev.vars` file (it is gitignored):

```sh
RATE_LIMIT_ENABLED=false
```

`pnpm check` runs the typecheck, the linter and the tests. The tests run in workerd against their own local D1 database.

## Updating

```sh
git pull
pnpm install
pnpm exec wrangler d1 migrations apply keepjson --remote
pnpm run deploy
```

Apply the migrations before deploying, so the new code never runs against an old schema. When there are no new migrations, Wrangler says so and changes nothing. Your edits to `wrangler.jsonc` (the `database_id` and your vars) may conflict with upstream changes on `git pull`; keep your values when you resolve them.

If you deployed with the button, your copy of the repo deploys itself on every push. Pull the upstream changes into it, apply any new migrations with the command above, then push.

## Demo environment

`wrangler.jsonc` also defines an environment named `demo`, with the demo Instance values from the table in step 4: every Bin expires within 30 days (`DEFAULT_TTL_SECONDS` and `MAX_TTL_SECONDS` are `2592000`), so a free-tier D1 database stays small. It deploys as a separate Worker, `keepjson-demo`.

Wrangler doesn't let a named environment inherit `vars`, `d1_databases` or `ratelimits` from the top level, so `env.demo` repeats them: it has its own D1 database (`keepjson-demo`) and its own rate limiter `namespace_id`s (`2001`, `2002`). To deploy it:

```sh
pnpm exec wrangler d1 create keepjson-demo
# put the printed database_id into env.demo.d1_databases in wrangler.jsonc
pnpm exec wrangler d1 migrations apply keepjson-demo --remote --env demo
pnpm exec wrangler deploy --env demo
```

Every Wrangler command for the demo needs `--env demo`; without it, the command acts on the top-level Instance.
