# keepjson

keepjson stores JSON documents for people who don't want to create an account: one REST call to save, one to fetch. It is an open-source, self-hostable alternative to jsonbin.io.

## Language

### Storage

**Bin**:
A single stored JSON document, addressed by an unguessable id.

**Expiry**:
The moment after which a Bin no longer exists.

### Access

**Write Key**:
The secret issued once, when a Bin is created, that grants the right to replace or delete it.

**Private Bin**:
A Bin whose content can only be read by someone holding one of its keys.

**Read Key**:
The secret issued with a Private Bin that grants read-only access to it.

### Operation

**Instance**:
One self-hosted deployment of keepjson, with its own limits and its own Bins.
