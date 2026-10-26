import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSqlite, migrate } from "../src/db"
import { Store } from "../src/store"
import { identityOf, availablePeers } from "../src/panel"

let dir: string
let store: Store
let sql: Awaited<ReturnType<typeof openSqlite>>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "swarm-panel-"))
  sql = await openSqlite(join(dir, "panel.db"))
  migrate(sql)
  store = new Store(sql)
})

const SCOPE = "svc\u0000proj\u0000/checkout"
const OLD_SCOPE = "old-hash-uuid\u0000proj\u0000/checkout"
const GRACE = 3_600_000

function seedIdentity(scope: string, session: string, name: string): void {
  store.acquireIdentity(scope, session, [name], undefined, () => 0)
}

test("markIdle anchors idle_since to last activity, not to the noticing time", () => {
  const t0 = 1_000_000
  const t1 = t0 + 2 * GRACE
  store.touchActive(SCOPE, "ses_a", t0)
  store.markIdle(SCOPE, "ses_a", t1)
  const row = store.presenceFor(SCOPE, "ses_a")!
  assert.equal(row.lastActiveAt, t0)
  assert.equal(row.idleSince, t0)
  assert.equal(row.suspended, false)
})

test("markIdle keeps the first idle anchor and is a no-op once idle", () => {
  const t0 = 1_000_000
  store.touchActive(SCOPE, "ses_a", t0)
  store.markIdle(SCOPE, "ses_a", t0 + 1000)
  store.markIdle(SCOPE, "ses_a", t0 + 2000)
  assert.equal(store.presenceFor(SCOPE, "ses_a")!.idleSince, t0)
})

test("stale idle session drops out of the available set after the grace", () => {
  const t0 = 1_000_000
  store.touchActive(SCOPE, "ses_a", t0)
  store.markIdle(SCOPE, "ses_a", t0 + 10)
  assert.ok(store.availableSessions(SCOPE, t0 + GRACE - 1, GRACE).has("ses_a"))
  assert.ok(!store.availableSessions(SCOPE, t0 + GRACE + 1, GRACE).has("ses_a"))
})

test("touchActive clears the idle state and re-anchors activity", () => {
  const t0 = 1_000_000
  store.touchActive(SCOPE, "ses_a", t0)
  store.markIdle(SCOPE, "ses_a", t0 + 10)
  store.touchActive(SCOPE, "ses_a", t0 + 5000)
  const row = store.presenceFor(SCOPE, "ses_a")!
  assert.equal(row.lastActiveAt, t0 + 5000)
  assert.equal(row.idleSince, null)
})

test("markSuspended anchors idle_since to last activity and hides the session", () => {
  const t0 = 1_000_000
  store.touchActive(SCOPE, "ses_a", t0)
  store.markSuspended(SCOPE, "ses_a", t0 + GRACE * 2)
  const row = store.presenceFor(SCOPE, "ses_a")!
  assert.equal(row.suspended, true)
  assert.equal(row.idleSince, t0)
  // Suspended wins even inside the grace window.
  assert.ok(!store.availableSessions(SCOPE, t0 + 1, GRACE).has("ses_a"))
  // Real work again: touch + clearSuspended, exactly like the coordinator does.
  store.touchActive(SCOPE, "ses_a", t0 + 2)
  store.clearSuspended(SCOPE, "ses_a", t0 + 2)
  assert.ok(store.availableSessions(SCOPE, t0 + 3, GRACE).has("ses_a"))
})

test("identityOf prefers the identity whose presence was touched most recently", () => {
  const t0 = 1_000_000
  seedIdentity(OLD_SCOPE, "ses_user", "abeja")
  store.touchActive(OLD_SCOPE, "ses_user", t0)
  seedIdentity(SCOPE, "ses_user", "liron")
  store.touchActive(SCOPE, "ses_user", t0 + 60_000)
  const identity = identityOf(sql, "ses_user")!
  assert.equal(identity.name, "liron")
  assert.equal(identity.scopeKey, SCOPE)
  // A later touch in another scope flips the current identity again.
  store.touchActive(OLD_SCOPE, "ses_user", t0 + 120_000)
  assert.equal(identityOf(sql, "ses_user")!.name, "abeja")
})

test("identityOf falls back to identities without presence and skips tombstones", () => {
  seedIdentity(SCOPE, "ses_a", "liron")
  assert.equal(identityOf(sql, "ses_a")!.name, "liron")
  seedIdentity(SCOPE, "ses_b", "aguila")
  store.touchActive(SCOPE, "ses_b", 1_000_000)
  store.tombstoneIdentity(SCOPE, "ses_b", 2_000_000)
  assert.equal(identityOf(sql, "ses_b"), undefined)
  assert.equal(identityOf(sql, "ses_unknown"), undefined)
})

test("availablePeers applies grace, suspension, tombstones and self exclusion", () => {
  const t0 = 1_000_000
  const now = t0 + GRACE + 60_000
  const s1 = (id: string, name: string, touch: number) => {
    seedIdentity(SCOPE, id, name)
    store.touchActive(SCOPE, id, touch)
  }
  s1("ses_fresh", "aguila", now - 1000)
  s1("ses_graced", "alce", now - 1000)
  store.markIdle(SCOPE, "ses_graced", now)
  s1("ses_stale", "alpaca", t0)
  store.markIdle(SCOPE, "ses_stale", t0 + 1)
  s1("ses_susp", "anaconda", now - 1000)
  store.markSuspended(SCOPE, "ses_susp", now)
  s1("ses_waiter", "búho", t0)
  store.markIdle(SCOPE, "ses_waiter", t0 + 1)
  s1("ses_me", "liron", now - 1000)
  store.tombstoneIdentity(SCOPE, "ses_susp", now + 1)

  store.insertWait({
    id: "w_1",
    scopeKey: SCOPE,
    messageID: "msg_1",
    fromSessionID: "ses_waiter",
    toSessionID: "ses_me",
    state: "waiting",
    durationMs: 120_000,
    deadlineAt: now + 60_000,
    now,
    ownerInstance: "i_test",
  })

  assert.deepEqual(availablePeers(sql, SCOPE, "ses_me", now, GRACE), ["aguila", "alce", "búho"])
})
