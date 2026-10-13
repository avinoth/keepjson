# Working on keepjson

keepjson is a Hono app on Cloudflare Workers + D1 that stores JSON Bins without accounts. Read `README.md` for what it does.

## Which job is this?

- **Deploying or running an Instance** (setup, D1, migrations, vars, `wrangler deploy`, the demo Instance): follow `docs/deploy.md` step by step and skip the sections below. Don't change code or commit.
  - Ask the user to run `pnpm exec wrangler login` themselves (suggest `! pnpm exec wrangler login`); it is interactive and needs their Cloudflare account.
  - Before `wrangler d1 create`, `migrations apply --remote` or `deploy`, tell the user what it will change in their account and wait for a go-ahead.
  - Put the printed `database_id` into `wrangler.jsonc` as the guide says. Don't invent values for vars the user hasn't chosen: ask, or keep the defaults.
  - Finish by checking `GET /health` on the deployed URL.
- **Changing the code**: read `CONTEXT.md` (vocabulary), then follow the rest of this file.

## How to work

- Write the tests first. Tests run in `@cloudflare/vitest-plugin` (formerly `@cloudflare/vitest-pool-workers`) against a real local D1. Don't mock D1.
- `pnpm check` must pass before you commit.
- All SQL goes in `src/bins/repository.ts`. Handlers don't build SQL.
- Never log, echo or persist a plaintext Write Key or Read Key.

## Language

Use the terms in `CONTEXT.md` exactly, in code, tests, docs and commit messages: `Bin`, `writeKey`, `readKey`, `expiresAt`, `Instance`. Don't use the words listed under _Avoid_ (no `document`, `record`, `masterKey`, `apiKey`, `token`).

## On new commits

- If a new domain term appears, add it to `CONTEXT.md` (glossary only, no implementation details).
