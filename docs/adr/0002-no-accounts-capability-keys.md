# No accounts: ownership through capability keys

keepjson has no users or accounts. Creating a Bin returns a Write Key, and a Read Key as well for a Private Bin. Holding a key is the only proof of rights over that Bin. The server stores only SHA-256 hashes of the keys, so a lost key cannot be recovered or reissued. This keeps "one curl call, no signup" possible. It also avoids storing passwords, sending email or keeping personal data.

## Consequences

- **No endpoint lists Bins, deliberately.** No "my bins" can exist without an owner identity. A global list would expose every public Bin. Clients must remember their own ids.
- Key rotation, and anything else that needs to know "who", has to be built on keys, not on identities.
