# Cloudflare Workers + D1, Bin content stored inline

keepjson runs on Cloudflare Workers (Hono) and stores each Bin's content as TEXT inline in its D1 row. D1's row cap (about 2 MB) is therefore the hard limit on Bin size. Each Instance enforces a smaller configurable maximum (default 100 KB).

## Consequences

- Self-hosting means a Cloudflare account. Porting to another runtime would mean replacing the storage layer, so all SQL stays behind one repository module.
- A free-tier D1 database holds about 500 MB in total, so the demo Instance relies on Expiry and the size limit to stay within it.
- Large Bins (over about 1 MB) need a later move to R2, recorded in a new ADR.
