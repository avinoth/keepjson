// All SQL for Bins lives in this module (ADR 0003). Times are unix ms.

export type Bin = {
  id: string;
  /** Raw JSON exactly as received. */
  content: string;
  isPrivate: boolean;
  /** Hex SHA-256 of the Write Key. */
  writeKeyHash: string;
  /** Hex SHA-256 of the Read Key; null unless the Bin is private. */
  readKeyHash: string | null;
  createdAt: number;
  updatedAt: number;
  /** null means the Bin never expires. */
  expiresAt: number | null;
};

type BinRow = {
  id: string;
  content: string;
  is_private: number;
  write_key_hash: string;
  read_key_hash: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
};

const LIVE = "(expires_at IS NULL OR expires_at > ?)";

export async function insert(db: D1Database, bin: Bin): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bins (id, content, is_private, write_key_hash, read_key_hash, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      bin.id,
      bin.content,
      bin.isPrivate ? 1 : 0,
      bin.writeKeyHash,
      bin.readKeyHash,
      bin.createdAt,
      bin.updatedAt,
      bin.expiresAt,
    )
    .run();
}

/** The Bin with this id, or null if there is none or its Expiry is at or before `now`. */
export async function findLive(db: D1Database, id: string, now: number): Promise<Bin | null> {
  const row = await db.prepare(`SELECT * FROM bins WHERE id = ? AND ${LIVE}`).bind(id, now).first<BinRow>();
  return row ? toBin(row) : null;
}

/** Replaces a live Bin's content. Returns false if no live Bin has this id. */
export async function replaceContent(db: D1Database, id: string, content: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE bins SET content = ?, updated_at = ? WHERE id = ? AND ${LIVE}`)
    .bind(content, now, id, now)
    .run();
  return result.meta.changes > 0;
}

/** Deletes a live Bin. Returns false if no live Bin has this id (an expired one is left for the sweep). */
export async function remove(db: D1Database, id: string, now: number): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM bins WHERE id = ? AND ${LIVE}`).bind(id, now).run();
  return result.meta.changes > 0;
}

/** Deletes at most `limit` Bins whose Expiry is at or before `now`. Returns how many were deleted. */
export async function deleteExpired(db: D1Database, now: number, limit: number): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM bins WHERE id IN (
         SELECT id FROM bins WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?
       )`,
    )
    .bind(now, limit)
    .run();
  return result.meta.changes;
}

function toBin(row: BinRow): Bin {
  return {
    id: row.id,
    content: row.content,
    isPrivate: row.is_private === 1,
    writeKeyHash: row.write_key_hash,
    readKeyHash: row.read_key_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}
