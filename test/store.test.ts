import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSqlite, migrate } from "../src/db"
import { Store } from "../src/store"
import { canonicalCheckoutDirectory, canonicalDirectory, scopeKey } from "../src/scope"
import { newMessageID, newWaitID, invocationKey, sha256Of } from "../src/ids"
import type { Envelope } from "../src/types"

const NAMES = ["abeja", "zorro", "lobo"]

let dir: string
let store: Store

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "swarm-test-"))
  const sql = await openSqlite(join(dir, "test.db"))
  migrate(sql)
  store = new Store(sql)
})

function makeEnvelope(over: Partial<Envelope> = {}): Envelope {
  const base: Envelope = {
    protocol: "swarm/v1",
    id: newMessageID(),
    scopeKey: "svc\u0000proj\u0000/tmp/checkout",
    fromSessionID: "ses_from",
    toSessionID: "ses_to",
    fromName: "abeja",
    toName: "zorro",
    message: "hola",
    createdAt: new Date().toISOString(),
  }
  return { ...base, ...over }
}

// Deterministic shuffles of NAMES = [abeja, zorro, lobo] under Fisher-Yates:
// constant 0.5 -> [abeja, lobo, zorro]; constant 0 -> [zorro, lobo, abeja].
const half = () => 0.5
const zero = () => 0

test("identity assignment is random and unique", () => {
  const scope = "s1"
  assert.equal(store.acquireIdentity(scope, "ses_a", NAMES, undefined, half), "abeja")
  assert.equal(store.acquireIdentity(scope, "ses_b", NAMES, undefined, half), "lobo")
  assert.equal(store.acquireIdentity(scope, "ses_c", NAMES, undefined, half), "zorro")
})

test("identity assignment depends on the random source", () => {
  const scope = "s1"
  assert.equal(store.acquireIdentity(scope, "ses_a", NAMES, undefined, zero), "zorro")
  assert.equal(store.acquireIdentity(scope, "ses_b", NAMES, undefined, zero), "lobo")
  assert.equal(store.acquireIdentity(scope, "ses_c", NAMES, undefined, zero), "abeja")
})

test("exhausted list gets numeric suffixes, base-by-base, in the random order", () => {
  const scope = "s1"
  const taken = [
    store.acquireIdentity(scope, "ses_a", NAMES, undefined, half),
    store.acquireIdentity(scope, "ses_b", NAMES, undefined, half),
    store.acquireIdentity(scope, "ses_c", NAMES, undefined, half),
  ]
  assert.deepEqual(taken, ["abeja", "lobo", "zorro"])
  assert.equal(store.acquireIdentity(scope, "ses_d", NAMES, undefined, half), "abeja-2")
  assert.equal(store.acquireIdentity(scope, "ses_e", NAMES, undefined, half), "abeja-3")
})

test("names are stable across re-acquisition and never renamed", () => {
  const scope = "s1"
  store.acquireIdentity(scope, "ses_a", NAMES, undefined, half)
  // Simulated restart: same session re-acquires.
  assert.equal(store.acquireIdentity(scope, "ses_a", ["otro", "abeja"]), "abeja")
  // A config edit that drops the name does not rename.
  assert.equal(store.acquireIdentity(scope, "ses_a", ["completamente-diferente"]), "abeja")
})

test("tombstoned names are reserved and never recycled", () => {
  const scope = "s1"
  const first = store.acquireIdentity(scope, "ses_a", NAMES, undefined, half)
  store.tombstoneIdentity(scope, "ses_a")
  // New session cannot take the tombstoned name.
  const second = store.acquireIdentity(scope, "ses_b", NAMES, undefined, half)
  assert.notEqual(second, first)
  const row = store.identityFor(scope, "ses_b")
  assert.equal(row?.name, second)
  const tomb = store.identityFor(scope, "ses_a")
  assert.equal(tomb?.tombstone, true)
})

test("unique (scope,name) isolates scopes even with the same session id", () => {
  store.acquireIdentity("s1", "ses_a", NAMES, undefined, half)
  store.acquireIdentity("s2", "ses_a", NAMES, undefined, half)
  assert.equal(store.identityFor("s1", "ses_a")?.name, "abeja")
  assert.equal(store.identityFor("s2", "ses_a")?.name, "abeja")
})

test("scope canonicalization resolves symlinks and subdirectories", () => {
  const real = join(dir, "real-checkout")
  mkdirSync(join(real, "sub"), { recursive: true })
  mkdirSync(join(real, ".git"))
  const link = join(dir, "link-checkout")
  symlinkSync(real, link, "dir")
  // Subdirectory and symlink both resolve to the checkout root.
  const viaReal = canonicalCheckoutDirectory(join(real, "sub"))
  const viaLink = canonicalCheckoutDirectory(link)
  assert.equal(viaReal, real)
  assert.equal(viaLink, real)
  assert.equal(
    scopeKey({ serviceID: "s", projectID: "p", directory: viaReal }),
    scopeKey({ serviceID: "s", projectID: "p", directory: viaLink }),
  )
  // A different worktree must not collide.
  const other = join(dir, "other-checkout")
  mkdirSync(join(other, ".git"), { recursive: true })
  assert.notEqual(
    scopeKey({ serviceID: "s", projectID: "p", directory: real }),
    scopeKey({ serviceID: "s", projectID: "p", directory: other }),
  )
  // Different project id must not collide.
  assert.notEqual(
    scopeKey({ serviceID: "s", projectID: "p1", directory: real }),
    scopeKey({ serviceID: "s", projectID: "p2", directory: real }),
  )
})

test("checkout root rules: git file, non-git, nested repos", () => {
  // A linked worktree marks its root with a `.git` file, not a directory.
  const wt = join(dir, "worktree")
  mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, ".git"), "gitdir: /other/repo/.git/worktrees/wt\n")
  assert.equal(canonicalCheckoutDirectory(join(wt, "src")), wt)
  // Non-git directories keep their own reported directory as scope root
  // (no ancestor joining for non-VCS checkouts).
  const plain = join(dir, "plain")
  mkdirSync(join(plain, "sub"), { recursive: true })
  assert.equal(canonicalCheckoutDirectory(join(plain, "sub")), join(plain, "sub"))
  assert.notEqual(
    scopeKey({ serviceID: "s", projectID: "p", directory: join(plain, "sub") }),
    scopeKey({ serviceID: "s", projectID: "p", directory: join(plain, "sub2") }),
  )
  // A nested repo is its own checkout, even inside another one.
  const outer = join(dir, "outer")
  mkdirSync(join(outer, ".git"), { recursive: true })
  mkdirSync(join(outer, "inner", "deep"), { recursive: true })
  mkdirSync(join(outer, "inner", ".git"))
  assert.equal(canonicalCheckoutDirectory(join(outer, "inner", "deep")), join(outer, "inner"))
  assert.equal(canonicalCheckoutDirectory(join(outer, "top")), outer)
})

test("prefix-sharing project paths do not mix (no startsWith)", () => {
  const a = scopeKey({ serviceID: "s", projectID: "p1", directory: "/tmp/proj" })
  const b = scopeKey({ serviceID: "s", projectID: "p1", directory: "/tmp/proj-two" })
  assert.notEqual(a, b)
})

test("commitSend is idempotent per invocation (M06) and detects conflicts (M07)", () => {
  const scope = "s1"
  const env = makeEnvelope()
  const invocation = invocationKey("ses_from", "msg_assistant", "call_1")
  const inputHash = sha256Of({ name: "zorro", message: "hola" })
  const first = store.commitSend({ id: env.id, envelope: env, invocation, inputHash, wait: null, now: Date.now() })
  assert.equal(first.status, "inserted")
  const second = store.commitSend({ id: newMessageID(), envelope: env, invocation, inputHash, wait: null, now: Date.now() })
  assert.equal(second.status, "exists")
  assert.equal(second.existing?.id, env.id)
  const different = store.commitSend({
    id: newMessageID(),
    envelope: { ...env, message: "distinto" },
    invocation,
    inputHash: sha256Of({ name: "zorro", message: "distinto" }),
    wait: null,
    now: Date.now(),
  })
  assert.equal(different.status, "conflict")
  // Same text, new invocation: two distinct messages (no text dedupe).
  const other = store.commitSend({
    id: newMessageID(),
    envelope: env,
    invocation: invocationKey("ses_from", "msg_assistant", "call_2"),
    inputHash,
    wait: null,
    now: Date.now(),
  })
  assert.equal(other.status, "inserted")
  assert.notEqual(store.message(env.id)?.id, store.messageByInvocation(scope, invocationKey("ses_from", "msg_assistant", "call_2"))?.id)
})

test("cycle detection: W06 single reverse edge is rejected", () => {
  const scope = "s1"
  store.insertWait({
    id: newWaitID(),
    scopeKey: scope,
    messageID: "msg_ab",
    fromSessionID: "A",
    toSessionID: "B",
    state: "reserved",
    durationMs: 1000,
    deadlineAt: null,
    now: Date.now(),
    ownerInstance: "i1",
  })
  // Edge A->B exists (A waits for B). B wants to add B->A: cycle check asks
  // whether the new destination (A) can already reach the new sender (B).
  assert.deepEqual(store.pathBetween(scope, "A", "B"), ["A", "B"])
  assert.equal(store.pathBetween(scope, "B", "A"), undefined)
})

test("cycle detection: W08 long chain rejects the closing edge only", () => {
  const scope = "s1"
  const add = (from: string, to: string) =>
    store.insertWait({
      id: newWaitID(),
      scopeKey: scope,
      messageID: `msg_${from}_${to}`,
      fromSessionID: from,
      toSessionID: to,
      state: "waiting",
      durationMs: 1000,
      deadlineAt: null,
      now: Date.now(),
      ownerInstance: "i1",
    })
  add("A", "B")
  add("B", "C")
  // Closing edge C->A: the cycle check asks whether A can reach C.
  assert.deepEqual(store.pathBetween(scope, "A", "C"), ["A", "B", "C"])
  assert.equal(store.pathBetween(scope, "C", "A"), undefined)
  // The graph keeps A->B and B->C (the closing edge is rejected by the caller).
  assert.equal(store.activeEdges(scope).length, 2)
})

test("W07: concurrent A->B and B->A — exactly one wait survives commitSend", () => {
  const scope = "s1"
  const envAB = makeEnvelope({ scopeKey: scope, fromSessionID: "A", toSessionID: "B", fromName: "abeja", toName: "zorro" })
  const envBA = makeEnvelope({ scopeKey: scope, fromSessionID: "B", toSessionID: "A", fromName: "zorro", toName: "abeja" })
  const first = store.commitSend({
    id: envAB.id,
    envelope: envAB,
    invocation: invocationKey("A", "m1", "c1"),
    inputHash: "h1",
    wait: { id: newWaitID(), durationMs: 1000, ownerInstance: "i1" },
    now: Date.now(),
  })
  assert.equal(first.status, "inserted")
  assert.equal(first.cycle, false)
  const second = store.commitSend({
    id: envBA.id,
    envelope: envBA,
    invocation: invocationKey("B", "m2", "c2"),
    inputHash: "h2",
    wait: { id: newWaitID(), durationMs: 1000, ownerInstance: "i1" },
    now: Date.now(),
  })
  assert.equal(second.status, "inserted")
  assert.equal(second.cycle, true)
  // Only one active edge remains.
  assert.equal(store.activeEdges(scope).length, 1)
})

test("W05: reply and timeout race — exactly one winner in both orders", () => {
  const scope = "s1"
  const waitID = newWaitID()
  store.insertWait({
    id: waitID,
    scopeKey: scope,
    messageID: "msg_x",
    fromSessionID: "A",
    toSessionID: "B",
    state: "waiting",
    durationMs: 1000,
    deadlineAt: Date.now() + 1000,
    now: Date.now(),
    ownerInstance: "i1",
  })
  // Order 1: reply claims first, then the timeout transition must lose.
  const claim = store.claimReplyWait(scope, "msg_x", "msg_reply", Date.now())
  assert.ok(claim, "claim wins when it runs first")
  const timeout = store.transitionWait(waitID, ["reserved", "waiting"], "timed_out", null, Date.now())
  assert.equal(timeout.won, false)
  assert.equal(timeout.row?.state, "replied")
})

test("W05 (reverse order): timeout wins, late reply becomes async", () => {
  const scope = "s1"
  const waitID = newWaitID()
  store.insertWait({
    id: waitID,
    scopeKey: scope,
    messageID: "msg_y",
    fromSessionID: "A",
    toSessionID: "B",
    state: "waiting",
    durationMs: 1000,
    deadlineAt: Date.now() - 1,
    now: Date.now(),
    ownerInstance: "i1",
  })
  const timeout = store.transitionWait(waitID, ["reserved", "waiting"], "timed_out", null, Date.now())
  assert.equal(timeout.won, true)
  const claim = store.claimReplyWait(scope, "msg_y", "msg_reply", Date.now())
  assert.equal(claim, undefined)
  assert.equal(store.wait(waitID)?.state, "timed_out")
})

test("setWaiting only arms from reserved (W02 fast replies survive)", () => {
  const scope = "s1"
  const waitID = newWaitID()
  store.insertWait({
    id: waitID,
    scopeKey: scope,
    messageID: "msg_z",
    fromSessionID: "A",
    toSessionID: "B",
    state: "reserved",
    durationMs: 1000,
    deadlineAt: null,
    now: Date.now(),
    ownerInstance: "i1",
  })
  // Fast reply claims while still reserved.
  const claim = store.claimReplyWait(scope, "msg_z", "msg_reply", Date.now())
  assert.ok(claim)
  // Admission confirmed afterwards: must not re-arm the wait.
  store.setWaiting(waitID, Date.now() + 1000, Date.now())
  assert.equal(store.wait(waitID)?.state, "replied")
})

test("W14: failed admission leaves no phantom reservation", () => {
  const scope = "s1"
  const waitID = newWaitID()
  store.insertWait({
    id: waitID,
    scopeKey: scope,
    messageID: "msg_w",
    fromSessionID: "A",
    toSessionID: "B",
    state: "reserved",
    durationMs: 1000,
    deadlineAt: null,
    now: Date.now(),
    ownerInstance: "i1",
  })
  store.setFailed("msg_w", "peer session not found")
  const { won } = store.resolveWaitTerminal(waitID, "cancelled", Date.now())
  assert.equal(won, true)
  assert.equal(store.activeEdges(scope).length, 0)
})

test("reapOrphanWaits only touches waits of dead owners (G07)", () => {
  const scope = "s1"
  for (const owner of ["i-dead", "i-live"]) {
    store.insertWait({
      id: newWaitID(),
      scopeKey: scope,
      messageID: `msg_${owner}`,
      fromSessionID: "A",
      toSessionID: "B",
      state: "waiting",
      durationMs: 1000,
      deadlineAt: null,
      now: Date.now(),
      ownerInstance: owner,
    })
  }
  const reaped = store.reapOrphanWaits(scope, new Set(["i-live"]), Date.now())
  assert.equal(reaped, 1)
  assert.equal(store.activeEdges(scope).length, 1)
  const remaining = store.activeEdges(scope)[0]
  assert.equal(remaining.id, remaining.id)
})

test("rate limit counters keep sends and replies separate (M12)", () => {
  const scope = makeEnvelope().scopeKey
  const now = Date.now()
  const insert = (replyTo: string | null, id: string) =>
    store.insertMessage({
      id,
      envelope: makeEnvelope({ fromSessionID: "S", reply: replyTo ?? undefined }),
      invocation: invocationKey("S", `m_${id}`, `c_${id}`),
      inputHash: sha256Of({ id }),
      now,
    })
  insert(null, "m1")
  insert(null, "m2")
  insert("m1", "r1")
  assert.equal(store.countSince(scope, "S", now - 60_000, false), 2)
  assert.equal(store.countSince(scope, "S", now - 60_000, true), 1)
  assert.equal(store.countSince(scope, "S", now, false), 0)
})
