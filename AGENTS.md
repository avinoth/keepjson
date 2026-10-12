# Working on keepjson

keepjson is a Hono app on Cloudflare Workers + D1 that stores JSON Bins without accounts. The repo is in its outline stage: the work is defined in `docs/TODO.md`.

## Before you change anything

1. Read `CONTEXT.md` (vocabulary).
2. Take the **first unticked task** in `docs/TODO.md`. Don't skip ahead or merge tasks.

## How to work

- Write the tests first. Tests run in `@cloudflare/vitest-plugin` (formerly `@cloudflare/vitest-pool-workers`) against a real local D1. Don't mock D1.
- One TODO task = one commit. Tick its boxes in `docs/TODO.md` in that same commit.
- `pnpm check` must pass before you commit.
- All SQL goes in `src/bins/repository.ts`. Handlers don't build SQL.
- Never log, echo or persist a plaintext Write Key or Read Key.

## Language

Use the terms in `CONTEXT.md` exactly, in code, tests, docs and commit messages: `Bin`, `writeKey`, `readKey`, `expiresAt`, `Instance`. Don't use the words listed under _Avoid_ (no `document`, `record`, `masterKey`, `apiKey`, `token`).

## On new commits

- If a new domain term appears, add it to `CONTEXT.md` (glossary only, no implementation details).
