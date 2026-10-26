// Read-only queries for the TUI sidebar panel. The panel polls the plugin
// state database with the same availability semantics as the server's
// availableSessions (idle rows expire after the grace period unless they own
// a live wait). Kept free of host imports so it is unit-testable against a
// real SQLite file.

import type { Sql } from "./db"

/**
 * Resolve the identity to display for a session. A session can hold identity
 * rows in several scopes (the scope key format has evolved across versions);
 * the one whose presence row was touched most recently is the session's
 * current identity, so stale rows from old scope families are never shown.
 */
export function identityOf(db: Sql, sessionID: string): { name: string; scopeKey: string } | undefined {
  const row = db.get(
    `SELECT i.name AS name, i.scope_key AS scope_key
       FROM identities i
       LEFT JOIN presence p
         ON p.scope_key = i.scope_key AND p.session_id = i.session_id
      WHERE i.session_id = ?
        AND i.tombstone = 0
      ORDER BY (p.last_active_at IS NULL) ASC, p.last_active_at DESC, i.name
      LIMIT 1`,
    [sessionID],
  )
  if (!row) return undefined
  return { name: String(row.name), scopeKey: String(row.scope_key) }
}

/** Non-tombstoned identities of the scope that are available at `now`. */
export function availablePeers(db: Sql, scopeKey: string, selfSession: string, now: number, idleGraceMs: number): string[] {
  const rows = db.all(
    `SELECT i.name AS name
       FROM identities i
       LEFT JOIN presence p
         ON p.scope_key = i.scope_key AND p.session_id = i.session_id
       WHERE i.scope_key = ?
         AND i.tombstone = 0
         AND i.session_id != ?
         AND (p.suspended IS NULL OR p.suspended = 0)
         AND (p.idle_since IS NULL
              OR p.idle_since + ? > ?
              OR EXISTS (
                SELECT 1 FROM waits w
                 WHERE w.scope_key = i.scope_key
                   AND w.from_session = i.session_id
                   AND w.state IN ('reserved', 'waiting')
              ))
       ORDER BY i.name`,
    [scopeKey, selfSession, idleGraceMs, now],
  )
  return rows.map((row) => String(row.name))
}
