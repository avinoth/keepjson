# One JSON document per id (Bin), not collections of records

An id addresses exactly one JSON document (a Bin), which is created, read, replaced and deleted as a whole.

## Consequences

- No server-side querying, filtering or partial updates. Clients fetch the whole Bin and replace the whole Bin.
- Collections can be added later as a separate concept layered on top. They must not be added by changing what a Bin is.
