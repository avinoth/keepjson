# keepjson

Store JSON with one HTTP call. No signup, no account, no SDK.
An open-source, self-hostable alternative to jsonbin.io, built on Hono, Cloudflare Workers and D1.

> **Status: pre-alpha, outline only.** None of the code exists yet. The design is in [`docs/`](./docs) and the build plan is in [`docs/TODO.md`](./docs/TODO.md).

## Planned API

```sh
# Create a Bin: the response gives you its id and a Write Key (shown only once)
curl -X POST https://<your-instance>/bins \
  -H 'Content-Type: application/json' \
  -d '{"hello":"world"}'
# → 201 {"id":"V1StGXR8_Z5jdHi6B-myT","writeKey":"kj_w_…","private":false,...}

# Read it (public Bins need no key)
curl https://<your-instance>/bins/V1StGXR8_Z5jdHi6B-myT

# Replace it
curl -X PUT https://<your-instance>/bins/V1StGXR8_Z5jdHi6B-myT \
  -H 'Authorization: Bearer kj_w_…' -H 'Content-Type: application/json' \
  -d '{"hello":"again"}'

# Delete it
curl -X DELETE https://<your-instance>/bins/V1StGXR8_Z5jdHi6B-myT \
  -H 'Authorization: Bearer kj_w_…'
```

Options on create:
- `X-Bin-Private: true` makes a Private Bin. You also get a read-only **Read Key** to share.
- `X-Bin-TTL: 86400` makes the Bin expire after a day.

> ⚠️ Anyone who has a Write Key can overwrite or delete that Bin. Don't embed Write Keys in frontend code.

The full contract is in [`docs/api.md`](./docs/api.md).

## Self-hosting

keepjson is designed to be self-hosted first: you deploy it to your own Cloudflare account with your own D1 database, and you set the limits (size, expiry, rate limits). A one-click deploy button and a setup guide are coming (see TODO §11).

## Docs

- [`CONTEXT.md`](./CONTEXT.md): domain vocabulary
- [`docs/api.md`](./docs/api.md): API contract
- [`docs/adr/`](./docs/adr): architecture decisions
- [`docs/TODO.md`](./docs/TODO.md): build plan
- [`AGENTS.md`](./AGENTS.md): how coding agents (and humans) should work on this repo

## License

[MIT](./LICENSE)
