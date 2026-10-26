// Data access over the shared SQLite store. All multi-step mutations that
// must be atomic across plugin instances run inside one BEGIN IMMEDIATE
// transaction; the database is the single coordination authority.

import type { Sql } from "./db"
import type {
  Envelope,
  Identity,
  InstructionStateRow,
  MessageRow,
  PresenceRow,
  SwarmResult,
  WaitRow,
  WaitState,
} from "./types"
import { shuffled, sha256 } from "./ids"

const ACTIVE_WAIT_STATES = ["reserved", "waiting"] as const

function rowToMessage(row: Record<string, unknown>): MessageRow {
  return {
    id: row.id as string,
    scopeKey: row.scope_key as string,
    fromSessionID: row.from_session as string,
    toSessionID: row.to_session as string,
    fromName: row.from_name as string,
    toName: row.to_name as string,
    body: row.body as string,
    replyTo: (row.reply_to as string | null) ?? null,
    createdAt: row.created_at as number,
    state: row.state as MessageRow["state"],
    invocation: row.invocation as string,
    inputHash: row.input_hash as string,
    attempts: row.attempts as number,
    nextAttemptAt: (row.next_attempt_at as number | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
  }
}

function rowToWait(row: Record<string, unknown>): WaitRow {
  return {
    id: row.id as string,
    scopeKey: row.scope_key as string,
    messageID: row.message_id as string,
    fromSessionID: row.from_session as string,
    toSessionID: row.to_session as string,
    state: row.state as WaitState,
    createdAt: row.created_at as number,
    deadlineAt: (row.deadline_at as number | null) ?? null,
    durationMs: row.duration_ms as number,
    replyMessageID: (row.reply_message_id as string | null) ?? null,
    resolvedAt: (row.resolved_at as number | null) ?? null,
    ownerInstance: row.owner_instance as string,
  }
}

function rowToPresence(row: Record<string, unknown>): PresenceRow {
  return {
    scopeKey: row.scope_key as string,
    sessionID: row.session_id as string,
    lastActiveAt: (row.last_active_at as number | null) ?? null,
    idleSince: (row.idle_since as number | null) ?? null,
    suspended: (row.suspended as number) === 1,
    lastReconciledAt: (row.last_reconciled_at as number | null) ?? null,
  }
}

export class Store {
  constructor(private readonly db: Sql) {}

  // ------------------------------------------------------------------ meta

  metaGet(key: string): string | undefined {
    return this.db.get("SELECT value FROM meta WHERE key = ?", [key])?.value as string | undefined
  }

  metaSet(key: string, value: string): void {
    this.db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    )
  }

  // ------------------------------------------------------------ identities

  identityFor(scopeKey: string, sessionID: string): Identity | undefined {
    const row = this.db.get(
      "SELECT scope_key, session_id, name, tombstone FROM identities WHERE scope_key = ? AND session_id = ?",
      [scopeKey, sessionID],
    )
    return row ? this.parseIdentity(row) : undefined
  }

  identityByName(scopeKey: string, name: string): Identity | undefined {
    const row = this.db.get(
      "SELECT scope_key, session_id, name, tombstone FROM identities WHERE scope_key = ? AND name = ?",
      [scopeKey, name],
    )
    return row ? this.parseIdentity(row) : undefined
  }

  identitiesAll(scopeKey: string): Identity[] {
    return this.db
      .all("SELECT scope_key, session_id, name, tombstone FROM identities WHERE scope_key = ?", [scopeKey])
      .map((row) => this.parseIdentity(row))
  }

  private parseIdentity(row: Record<string, unknown>): Identity {
    return {
      scopeKey: row.scope_key as string,
      sessionID: row.session_id as string,
      name: row.name as string,
      tombstone: (row.tombstone as number) === 1,
    }
  }

  /**
   * Atomically ensure the session has a name in this scope. Candidates are
   * drawn in random order (Fisher-Yates over the name list) so names are not
   * handed out in list order; when every base name is taken, numeric
   * suffixes (base-2, base-3, ...) are tried in the same random order. A
   * taken (scope, name) unique violation moves to the next candidate, so
   * concurrent acquisitions never collide. Existing rows are returned
   * unchanged (names are never renamed by config edits).
   */
  acquireIdentity(
    scopeKey: string,
    sessionID: string,
    names: readonly string[],
    now = Date.now(),
    random: () => number = Math.random,
  ): string {
    return this.db.withTransaction(() => {
      const existing = this.identityFor(scopeKey, sessionID)
      if (existing) return existing.name
      const insert = (name: string): boolean => {
        try {
          this.db.run(
            "INSERT INTO identities (scope_key, session_id, name, tombstone, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
            [scopeKey, sessionID, name, now, now],
          )
          return true
        } catch (error) {
          if (String(error).includes("UNIQUE")) return false
          throw error
        }
      }
      const ordered = shuffled(names, random)
      for (const name of ordered) if (insert(name)) return name
      for (const base of ordered) {
        for (let n = 2; ; n++) {
          if (insert(`${base}-${n}`)) return `${base}-${n}`
          // Bounded by available candidates; in practice unreachable.
          if (n > 10_000) throw new Error(`name space exhausted for scope`)
        }
      }
      throw new Error("empty names list")
    })
  }

  tombstoneIdentity(scopeKey: string, sessionID: string, now = Date.now()): void {
    this.db.run(
      "UPDATE identities SET tombstone = 1, updated_at = ? WHERE scope_key = ? AND session_id = ?",
      [now, scopeKey, sessionID],
    )
  }

  // ------------------------------------------------------------ presence

  presenceFor(scopeKey: string, sessionID: string): PresenceRow | undefined {
    const row = this.db.get(
      "SELECT * FROM presence WHERE scope_key = ? AND session_id = ?",
      [scopeKey, sessionID],
    )
    return row ? rowToPresence(row) : undefined
  }

  presenceAll(scopeKey: string): PresenceRow[] {
    return this.db.all("SELECT * FROM presence WHERE scope_key = ?", [scopeKey]).map(rowToPresence)
  }

  /** Insert or touch a presence row from an activity signal. */
  touchActive(scopeKey: string, sessionID: string, now = Date.now()): void {
    this.db.run(
      `INSERT INTO presence (scope_key, session_id, last_active_at, idle_since, suspended)
       VALUES (?, ?, ?, NULL, 0)
       ON CONFLICT(scope_key, session_id) DO UPDATE SET
         last_active_at = ?,
         idle_since = NULL`,
      [scopeKey, sessionID, now, now],
    )
  }

  markIdle(scopeKey: string, sessionID: string, now = Date.now()): void {
    // idle_since anchors to the last recorded activity, not to the moment the
    // idle state was noticed: peers whose activity ended more than the grace
    // period ago drop out of the available set immediately, while parked
    // sessions stay discoverable for the full grace after their last touch.
    this.db.run(
      `INSERT INTO presence (scope_key, session_id, last_active_at, idle_since, suspended)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(scope_key, session_id) DO UPDATE SET
         idle_since = COALESCE(idle_since, last_active_at)`,
      [scopeKey, sessionID, now, now],
    )
  }

  markSuspended(scopeKey: string, sessionID: string, now = Date.now()): void {
    this.db.run(
      `INSERT INTO presence (scope_key, session_id, last_active_at, idle_since, suspended)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(scope_key, session_id) DO UPDATE SET
         suspended = 1,
         idle_since = COALESCE(idle_since, last_active_at)`,
      [scopeKey, sessionID, now, now],
    )
  }

  clearSuspended(scopeKey: string, sessionID: string, now = Date.now()): void {
    this.db.run("UPDATE presence SET suspended = 0 WHERE scope_key = ? AND session_id = ?", [
      scopeKey,
      sessionID,
    ])
  }

  removePresence(scopeKey: string, sessionID: string): void {
    this.db.run("DELETE FROM presence WHERE scope_key = ? AND session_id = ?", [scopeKey, sessionID])
  }

  /** Sessions in the scope that have a live swarm wait (they stay discoverable). */
  liveWaiters(scopeKey: string): Set<string> {
    const rows = this.db.all(
      "SELECT DISTINCT from_session AS session_id FROM waits WHERE scope_key = ? AND state IN (?, ?)",
      [scopeKey, "reserved", "waiting"],
    )
    return new Set(rows.map((row) => row.session_id as string))
  }

  /** Compute the available (discoverable) set for a scope at `now`. */
  availableSessions(scopeKey: string, now = Date.now(), idleGraceMs = 0): Set<string> {
    const waiters = this.liveWaiters(scopeKey)
    const result = new Set<string>()
    for (const row of this.presenceAll(scopeKey)) {
      if (row.suspended) continue
      if (row.idleSince === null) {
        result.add(row.sessionID)
        continue
      }
      if (row.idleSince + idleGraceMs > now) result.add(row.sessionID)
      else if (waiters.has(row.sessionID)) result.add(row.sessionID)
    }
    return result
  }

  // -------------------------------------------------------------- messages

  message(id: string): MessageRow | undefined {
    const row = this.db.get("SELECT * FROM messages WHERE id = ?", [id])
    return row ? rowToMessage(row) : undefined
  }

  messageByInvocation(scopeKey: string, invocation: string): MessageRow | undefined {
    const row = this.db.get("SELECT * FROM messages WHERE scope_key = ? AND invocation = ?", [scopeKey, invocation])
    return row ? rowToMessage(row) : undefined
  }

  originalForReply(scopeKey: string, replyTo: string): MessageRow | undefined {
    const row = this.db.get(
      "SELECT * FROM messages WHERE scope_key = ? AND id = ? AND (reply_to IS NULL OR 0)",
      [scopeKey, replyTo],
    )
    if (!row) return undefined
    const message = rowToMessage(row)
    return message
  }

  countSince(scopeKey: string, fromSessionID: string, since: number, replies: boolean): number {
    const row = this.db.get(
      `SELECT COUNT(*) AS n FROM messages
       WHERE scope_key = ? AND from_session = ? AND created_at > ?
         AND ${replies ? "reply_to IS NOT NULL" : "reply_to IS NULL"}`,
      [scopeKey, fromSessionID, since],
    )
    return Number(row?.n ?? 0)
  }

  /**
   * Persist the send intent. Fails with "exists:<id>" when the same
   * invocation was already recorded (the caller reconciles), or
   * "conflict" when the invocation maps to a different input.
   */
  insertMessage(input: {
    readonly id: string
    readonly envelope: Envelope
    readonly invocation: string
    readonly inputHash: string
    readonly now: number
  }): { readonly status: "inserted" | "exists" | "conflict"; readonly existing?: MessageRow } {
    const existing = this.db.get("SELECT * FROM messages WHERE invocation = ?", [input.invocation])
    if (existing) {
      const row = rowToMessage(existing)
      if (row.inputHash === input.inputHash) return { status: "exists", existing: row }
      return { status: "conflict" }
    }
    this.db.run(
      `INSERT INTO messages (id, scope_key, from_session, to_session, from_name, to_name, body, reply_to,
                             created_at, state, invocation, input_hash, attempts, next_attempt_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, NULL, NULL)`,
      [
        input.id,
        input.envelope.scopeKey,
        input.envelope.fromSessionID,
        input.envelope.toSessionID,
        input.envelope.fromName,
        input.envelope.toName,
        input.envelope.message,
        input.envelope.reply ?? null,
        input.now,
        input.invocation,
        input.inputHash,
      ],
    )
    return { status: "inserted" }
  }

  /**
   * Single atomic transition covering the send pipeline's commit step:
   * idempotency check, message intent, and (when a wait was requested) the
   * cycle check plus wait reservation — all under one BEGIN IMMEDIATE so
   * every plugin instance serializes through the same authority.
   */
  commitSend(input: {
    readonly id: string
    readonly envelope: Envelope
    readonly invocation: string
    readonly inputHash: string
    readonly wait: { readonly id: string; readonly durationMs: number; readonly ownerInstance: string } | null
    readonly now: number
  }): {
    readonly status: "inserted" | "exists" | "conflict"
    readonly existing?: MessageRow
    readonly cycle: boolean
    readonly waitID?: string
  } {
    return this.db.withTransaction(() => {
      const existingRow = this.db.get("SELECT * FROM messages WHERE invocation = ?", [input.invocation])
      if (existingRow) {
        const existing = rowToMessage(existingRow)
        if (existing.inputHash === input.inputHash) return { status: "exists" as const, existing, cycle: false }
        return { status: "conflict" as const, cycle: false }
      }
      try {
        this.db.run(
          `INSERT INTO messages (id, scope_key, from_session, to_session, from_name, to_name, body, reply_to,
                                  created_at, state, invocation, input_hash, attempts, next_attempt_at, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, NULL, NULL)`,
          [
            input.id,
            input.envelope.scopeKey,
            input.envelope.fromSessionID,
            input.envelope.toSessionID,
            input.envelope.fromName,
            input.envelope.toName,
            input.envelope.message,
            input.envelope.reply ?? null,
            input.now,
            input.invocation,
            input.inputHash,
          ],
        )
      } catch (error) {
        // Unique invocation hit a concurrent insertion between the check and
        // the write; re-read and reconcile instead of failing.
        if (String(error).includes("UNIQUE")) {
          const row = this.db.get("SELECT * FROM messages WHERE invocation = ?", [input.invocation])
          if (!row) throw error
          const existing = rowToMessage(row)
          if (existing.inputHash === input.inputHash) return { status: "exists" as const, existing, cycle: false }
          return { status: "conflict" as const, cycle: false }
        }
        throw error
      }
      if (input.wait) {
        const path = this.pathBetween(input.envelope.scopeKey, input.envelope.toSessionID, input.envelope.fromSessionID)
        if (path) return { status: "inserted" as const, cycle: true }
        this.db.run(
          `INSERT INTO waits (id, scope_key, message_id, from_session, to_session, state, created_at,
                              deadline_at, duration_ms, reply_message_id, resolved_at, owner_instance)
           VALUES (?, ?, ?, ?, ?, 'reserved', ?, NULL, ?, NULL, NULL, ?)`,
          [
            input.wait.id,
            input.envelope.scopeKey,
            input.id,
            input.envelope.fromSessionID,
            input.envelope.toSessionID,
            input.now,
            input.wait.durationMs,
            input.wait.ownerInstance,
          ],
        )
        return { status: "inserted" as const, cycle: false, waitID: input.wait.id }
      }
      return { status: "inserted" as const, cycle: false }
    })
  }

  setAdmitted(id: string): void {
    this.db.run("UPDATE messages SET state = 'admitted' WHERE id = ? AND state IN ('pending', 'unknown')", [id])
  }

  setFailed(id: string, reason: string): void {
    this.db.run("UPDATE messages SET state = 'failed', last_error = ? WHERE id = ?", [reason, id])
  }

  setUnknown(id: string, reason: string): void {
    this.db.run(
      "UPDATE messages SET state = 'unknown', last_error = ? WHERE id = ? AND state IN ('pending', 'unknown')",
      [reason, id],
    )
  }

  recordAttempt(id: string, nextAttemptAt: number | null): void {
    this.db.run(
      "UPDATE messages SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?",
      [nextAttemptAt, id],
    )
  }

  /** Pending admissions due for retry at `now` (inside the retry window). */
  dueRetries(scopeKey: string, now: number, retryWindowMs: number): MessageRow[] {
    const rows = this.db.all(
      `SELECT * FROM messages
       WHERE scope_key = ? AND state IN ('pending', 'unknown')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND created_at + ? >= ?`,
      [scopeKey, now, retryWindowMs, now],
    )
    return rows.map(rowToMessage)
  }

  /** Retries that exhausted the automatic window, kept for inspection. */
  expiredRetries(scopeKey: string, now: number, retryWindowMs: number): MessageRow[] {
    const rows = this.db.all(
      `SELECT * FROM messages
       WHERE scope_key = ? AND state IN ('pending', 'unknown') AND created_at + ? < ?`,
      [scopeKey, retryWindowMs, now],
    )
    return rows.map(rowToMessage)
  }

  // ----------------------------------------------------------------- waits

  insertWait(input: {
    readonly id: string
    readonly scopeKey: string
    readonly messageID: string
    readonly fromSessionID: string
    readonly toSessionID: string
    readonly state: "reserved" | "waiting"
    readonly durationMs: number
    readonly deadlineAt: number | null
    readonly now: number
    readonly ownerInstance: string
  }): void {
    this.db.run(
      `INSERT INTO waits (id, scope_key, message_id, from_session, to_session, state, created_at,
                          deadline_at, duration_ms, reply_message_id, resolved_at, owner_instance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      [
        input.id,
        input.scopeKey,
        input.messageID,
        input.fromSessionID,
        input.toSessionID,
        input.state,
        input.now,
        input.deadlineAt,
        input.durationMs,
        input.ownerInstance,
      ],
    )
  }

  wait(id: string): WaitRow | undefined {
    const row = this.db.get("SELECT * FROM waits WHERE id = ?", [id])
    return row ? rowToWait(row) : undefined
  }

  liveWaitForMessage(scopeKey: string, messageID: string): WaitRow | undefined {
    const row = this.db.get(
      "SELECT * FROM waits WHERE scope_key = ? AND message_id = ? AND state IN (?, ?)",
      [scopeKey, messageID, "reserved", "waiting"],
    )
    return row ? rowToWait(row) : undefined
  }

  /** Latest wait row for a message in any state (reconciliation of retries). */
  anyWaitForMessage(scopeKey: string, messageID: string): WaitRow | undefined {
    const row = this.db.get(
      "SELECT * FROM waits WHERE scope_key = ? AND message_id = ? ORDER BY created_at DESC LIMIT 1",
      [scopeKey, messageID],
    )
    return row ? rowToWait(row) : undefined
  }

  setWaiting(id: string, deadlineAt: number, now: number): void {
    this.db.run(
      "UPDATE waits SET state = 'waiting', deadline_at = ?, resolved_at = NULL WHERE id = ? AND state = 'reserved'",
      [deadlineAt, id],
    )
  }

  /**
   * Atomic reply/timeout race: a single conditional UPDATE, so exactly one
   * caller across all plugin instances can win the transition.
   */
  transitionWait(
    id: string,
    from: readonly WaitState[],
    to: WaitState,
    replyMessageID: string | null,
    now: number,
  ): { readonly won: boolean; readonly row: WaitRow | undefined } {
    const conditions = from.map(() => "state = ?").join(" OR ")
    const changed = this.db.run(
      `UPDATE waits SET state = ?, reply_message_id = COALESCE(?, reply_message_id), resolved_at = ?
       WHERE id = ? AND (${conditions})`,
      [to, replyMessageID, now, id, ...from],
    )
    return { won: changed > 0, row: this.wait(id) }
  }

  /** Terminal resolution used for cancellation and deterministic failures. */
  resolveWaitTerminal(id: string, to: WaitState, now: number): { readonly won: boolean; readonly row: WaitRow | undefined } {
    return this.transitionWait(id, ["reserved", "waiting"], to, null, now)
  }

  /**
   * Find and claim the live wait for a message in one transaction: the reply
   * is the winner exactly once. Returns the claimed wait or undefined.
   */
  claimReplyWait(scopeKey: string, messageID: string, replyMessageID: string, now: number): WaitRow | undefined {
    return this.db.withTransaction(() => {
      const existing = this.db.get(
        "SELECT * FROM waits WHERE scope_key = ? AND message_id = ? AND state IN (?, ?)",
        [scopeKey, messageID, "reserved", "waiting"],
      )
      if (!existing) return undefined
      this.db.run(
        "UPDATE waits SET state = 'replied', reply_message_id = ?, resolved_at = ? WHERE id = ?",
        [replyMessageID, now, String(existing.id)],
      )
      return rowToWait(existing)
    })
  }

  /** Active graph edges in a scope (reserved counts: reservation precedes dispatch). */
  activeEdges(scopeKey: string): Array<{ readonly from: string; readonly to: string; readonly id: string }> {
    return this.db.all(
      `SELECT from_session AS src, to_session AS dst, id FROM waits
       WHERE scope_key = ? AND state IN (?, ?)`,
      [scopeKey, "reserved", "waiting"],
    ).map((row) => ({ from: row.src as string, to: row.dst as string, id: row.id as string }))
  }

  /**
   * Is there a path from `from` to `to` through active edges? Returns the
   * node path (session ids, from...to) or undefined.
   */
  pathBetween(scopeKey: string, from: string, to: string): string[] | undefined {
    const edges = this.activeEdges(scopeKey)
    const adjacency = new Map<string, string[]>()
    for (const edge of edges) {
      const list = adjacency.get(edge.from) ?? []
      list.push(edge.to)
      adjacency.set(edge.from, list)
    }
    const stack: Array<{ node: string; path: string[] }> = [{ node: from, path: [from] }]
    const seen = new Set<string>([from])
    while (stack.length > 0) {
      const { node, path } = stack.pop() as { node: string; path: string[] }
      for (const next of adjacency.get(node) ?? []) {
        if (next === to) return [...path, next]
        if (seen.has(next)) continue
        seen.add(next)
        stack.push({ node: next, path: [...path, next] })
      }
    }
    return undefined
  }

  /**
   * Reap wait edges whose owning instance is dead. The caller decides which
   * instances are alive; this only touches non-terminal rows.
   */
  reapOrphanWaits(scopeKey: string, liveInstances: ReadonlySet<string>, now: number): number {
    let reaped = 0
    this.db.withTransaction(() => {
      const rows = this.db.all(
        "SELECT id, owner_instance FROM waits WHERE scope_key = ? AND state IN (?, ?)",
        [scopeKey, "reserved", "waiting"],
      )
      for (const row of rows) {
        if (liveInstances.has(row.owner_instance as string)) continue
        this.db.run("UPDATE waits SET state = 'abandoned', resolved_at = ? WHERE id = ?", [now, String(row.id)])
        reaped++
      }
    })
    return reaped
  }

  // ------------------------------------------------------- instruction state

  instructionState(scopeKey: string, sessionID: string, key: string): InstructionStateRow | undefined {
    const row = this.db.get(
      "SELECT * FROM instruction_state WHERE scope_key = ? AND session_id = ? AND key = ?",
      [scopeKey, sessionID, key],
    )
    if (!row) return undefined
    return {
      scopeKey: row.scope_key as string,
      sessionID: row.session_id as string,
      key: row.key as string,
      desiredJson: row.desired_json as string,
      desiredHash: row.desired_hash as string,
      confirmedHash: (row.confirmed_hash as string | null) ?? null,
      updatedAt: row.updated_at as number,
    }
  }

  setInstructionDesired(scopeKey: string, sessionID: string, key: string, desiredJson: string, now = Date.now()): void {
    this.db.run(
      `INSERT INTO instruction_state (scope_key, session_id, key, desired_json, desired_hash, confirmed_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(scope_key, session_id, key) DO UPDATE SET
         desired_json = excluded.desired_json,
         desired_hash = excluded.desired_hash,
         updated_at = excluded.updated_at`,
      [scopeKey, sessionID, key, desiredJson, sha256(desiredJson), now],
    )
  }

  confirmInstruction(scopeKey: string, sessionID: string, key: string, hash: string, now = Date.now()): void {
    this.db.run(
      "UPDATE instruction_state SET confirmed_hash = ?, updated_at = ? WHERE scope_key = ? AND session_id = ? AND key = ?",
      [hash, now, scopeKey, sessionID, key],
    )
  }

  instructionRows(scopeKey: string, sessionID: string): InstructionStateRow[] {
    return this.db
      .all("SELECT * FROM instruction_state WHERE scope_key = ? AND session_id = ?", [scopeKey, sessionID])
      .map((row) => ({
        scopeKey: row.scope_key as string,
        sessionID: row.session_id as string,
        key: row.key as string,
        desiredJson: row.desired_json as string,
        desiredHash: row.desired_hash as string,
        confirmedHash: (row.confirmed_hash as string | null) ?? null,
        updatedAt: row.updated_at as number,
      }))
  }

  removeInstructionState(scopeKey: string, sessionID: string): void {
    this.db.run("DELETE FROM instruction_state WHERE scope_key = ? AND session_id = ?", [scopeKey, sessionID])
  }

  // ----------------------------------------------------------------- owners

  acquireOwnership(scopeKey: string, instanceID: string, now: number, leaseMs: number): boolean {
    return this.db.withTransaction(() => {
      const row = this.db.get("SELECT * FROM owners WHERE scope_key = ?", [scopeKey])
      if (row) {
        if (row.instance_id === instanceID) {
          this.db.run("UPDATE owners SET state = 'alive', renewed_at = ?, expires_at = ? WHERE scope_key = ?", [
            now,
            now + leaseMs,
            scopeKey,
          ])
          return true
        }
        if (row.state === "alive" && Number(row.expires_at) > now) return false
        this.db.run(
          "UPDATE owners SET instance_id = ?, state = 'alive', renewed_at = ?, expires_at = ? WHERE scope_key = ?",
          [instanceID, now, now + leaseMs, scopeKey],
        )
        return true
      }
      this.db.run("INSERT INTO owners (scope_key, instance_id, state, renewed_at, expires_at) VALUES (?, ?, 'alive', ?, ?)", [
        scopeKey,
        instanceID,
        now,
        now + leaseMs,
      ])
      return true
    })
  }

  releaseOwnership(scopeKey: string, instanceID: string, now: number): void {
    this.db.run(
      "UPDATE owners SET state = 'dead', renewed_at = ? WHERE scope_key = ? AND instance_id = ?",
      [now, scopeKey, instanceID],
    )
  }

  liveOwners(now: number): Map<string, string> {
    const rows = this.db.all("SELECT * FROM owners")
    const result = new Map<string, string>()
    for (const row of rows) {
      if (row.state === "alive" && Number(row.expires_at) > now) result.set(row.scope_key as string, row.instance_id as string)
    }
    return result
  }

  markInstanceDead(instanceID: string, now: number): void {
    this.db.run("UPDATE owners SET state = 'dead', renewed_at = ? WHERE instance_id = ?", [now, instanceID])
  }

  close(): void {
    this.db.close()
  }
}

export { ACTIVE_WAIT_STATES }

export type { SwarmResult }
