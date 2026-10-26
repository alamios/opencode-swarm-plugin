// Thin SQLite wrapper with two drivers: bun:sqlite in the OpenCode host
// (the compiled CLI is a Bun runtime) and node:sqlite for tests. SQL is plain
// SQLite, so both drivers share every statement.

export type SqlValue = string | number | null
export type Row = Record<string, SqlValue | undefined>

export interface Sql {
  /** Number of rows modified by the statement. */
  run(sql: string, params?: readonly SqlValue[]): number
  get(sql: string, params?: readonly SqlValue[]): Row | undefined
  all(sql: string, params?: readonly SqlValue[]): Row[]
  exec(sql: string): void
  /**
   * Run fn inside BEGIN IMMEDIATE ... COMMIT. BEGIN IMMEDIATE takes the write
   * lock up front, which is what makes read-check-write sequences (cycle
   * detection, wait resolution) atomic across plugin instances.
   */
  withTransaction<T>(fn: () => T): T
  close(): void
}

interface BunQuery {
  run(...params: readonly SqlValue[]): number
  get(...params: readonly SqlValue[]): Row | undefined
  all(...params: readonly SqlValue[]): Row[]
}
interface BunDatabase {
  query(sql: string): BunQuery
  exec(sql: string): void
  close(): void
}
interface NodeDatabase {
  prepare(sql: string): {
    run(...params: readonly SqlValue[]): { changes: number | bigint }
    get(...params: readonly SqlValue[]): Record<string, unknown> | undefined
    all(...params: readonly SqlValue[]): Record<string, unknown>[]
  }
  exec(sql: string): void
  close(): void
}

/** node:sqlite may return bigint for large integers; normalize to number. */
function normalizeRow(row: Record<string, unknown>): Row {
  const out: Row = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "bigint" ? Number(value) : (value as SqlValue | undefined)
  }
  return out
}

export function makeSql(database: {
  prepare(sql: string): { run(...p: readonly SqlValue[]): { changes: number | bigint } | number; get(...p: readonly SqlValue[]): Row | undefined; all(...p: readonly SqlValue[]): Row[] }
  exec(sql: string): void
  close(): void
  begin?: () => void
}): Sql {
  const run = (sql: string, params: readonly SqlValue[] = []): number => {
    const result = database.prepare(sql).run(...params)
    const changes = typeof result === "number" ? result : result.changes
    return Number(changes)
  }
  const get = (sql: string, params: readonly SqlValue[] = []): Row | undefined => {
    const stmt = database.prepare(sql)
    return stmt.get(...params)
  }
  const all = (sql: string, params: readonly SqlValue[] = []): Row[] => {
    const stmt = database.prepare(sql)
    return stmt.all(...params)
  }
  const exec = (sql: string): void => database.exec(sql)
  return {
    run,
    get,
    all,
    exec,
    withTransaction<T>(fn: () => T): T {
      exec("BEGIN IMMEDIATE")
      try {
        const result = fn()
        exec("COMMIT")
        return result
      } catch (error) {
        try {
          exec("ROLLBACK")
        } catch {
          // transaction may already be aborted
        }
        throw error
      }
    },
    close: () => database.close(),
  }
}

export async function openSqlite(path: string): Promise<Sql> {
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite")
    const db: BunDatabase = new Database(path, { create: true })
    db.exec("PRAGMA journal_mode = WAL;")
    db.exec("PRAGMA busy_timeout = 5000;")
    db.exec("PRAGMA foreign_keys = ON;")
    const wrapped = {
      prepare: (sql: string) => db.query(sql),
      exec: (sql: string) => db.exec(sql),
      close: () => db.close(),
    }
    return makeSql(wrapped)
  }
  const { DatabaseSync } = await import("node:sqlite")
  const db: NodeDatabase = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA busy_timeout = 5000;")
  db.exec("PRAGMA foreign_keys = ON;")
  const wrapped = {
    prepare: (sql: string) => {
      const stmt = db.prepare(sql)
      return {
        run: (...params: readonly SqlValue[]) => stmt.run(...params),
        get: (...params: readonly SqlValue[]) => {
          const row = stmt.get(...params)
          return row === undefined ? undefined : normalizeRow(row)
        },
        all: (...params: readonly SqlValue[]) => stmt.all(...params).map(normalizeRow),
      }
    },
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
  }
  return makeSql(wrapped)
}

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS identities (
    scope_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    tombstone INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope_key, session_id),
    UNIQUE (scope_key, name)
  )`,
  `CREATE TABLE IF NOT EXISTS presence (
    scope_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    last_active_at INTEGER,
    idle_since INTEGER,
    suspended INTEGER NOT NULL DEFAULT 0,
    last_reconciled_at INTEGER,
    PRIMARY KEY (scope_key, session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    from_session TEXT NOT NULL,
    to_session TEXT NOT NULL,
    from_name TEXT NOT NULL,
    to_name TEXT NOT NULL,
    body TEXT NOT NULL,
    reply_to TEXT,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    invocation TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    last_error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS messages_scope_time ON messages (scope_key, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS messages_invocation ON messages (invocation)`,
  `CREATE INDEX IF NOT EXISTS messages_reply ON messages (scope_key, reply_to)`,
  `CREATE TABLE IF NOT EXISTS waits (
    id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    message_id TEXT NOT NULL,
    from_session TEXT NOT NULL,
    to_session TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deadline_at INTEGER,
    duration_ms INTEGER NOT NULL,
    reply_message_id TEXT,
    resolved_at INTEGER,
    owner_instance TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS waits_scope_state ON waits (scope_key, state)`,
  `CREATE INDEX IF NOT EXISTS waits_message ON waits (scope_key, message_id)`,
  `CREATE TABLE IF NOT EXISTS instruction_state (
    scope_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    key TEXT NOT NULL,
    desired_json TEXT NOT NULL,
    desired_hash TEXT NOT NULL,
    confirmed_hash TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope_key, session_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS owners (
    scope_key TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'alive',
    renewed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
]

export function migrate(db: Sql): void {
  db.exec("BEGIN IMMEDIATE")
  try {
    for (const statement of MIGRATIONS) db.exec(statement)
    db.exec("COMMIT")
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // ignore
    }
    throw error
  }
}
