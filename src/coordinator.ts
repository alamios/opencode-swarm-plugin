// Coordinator: the runtime that ties presence, identity, instructions,
// sends, waits and retries together for one scope. One Coordinator is created
// per plugin instance (per location); the shared SQLite store is the single
// coordination authority, so several instances of the same scope converge.

import type { Envelope, Identity, LoadedConfig, MessageRow, SwarmResult, WaitRow } from "./types"
import { Store } from "./store"
import { ServiceClient, ServiceError } from "./service"
import { scopeKey, type ScopeInput } from "./scope"
import { invocationKey, newMessageID, newWaitID, sha256, sha256Of } from "./ids"
import { envelopeMetadata, renderOutbound, renderSwarmContext } from "./render"
import { renderPrompt } from "./config"

export interface CallContext {
  readonly sessionID: string
  readonly messageID: string
  readonly callID: string
  readonly signal: AbortSignal
  readonly progress?: (update: Record<string, unknown>) => Promise<void>
}

export interface SwarmSendInput {
  name: string
  message: string
  reply_to?: string
  wait_for_reply?: boolean
}

interface CachedSession {
  readonly scopeKey: string
  readonly parentID?: string
  readonly directory: string
  readonly projectID: string
  readonly archived: boolean
  readonly deleted: boolean
  readonly at: number
}

interface WaitEntry {
  readonly name: string
  readonly messageID: string
  readonly resolves: Set<(result: SwarmResult) => void>
}

const CACHE_TTL_MS = 30_000
const HEARTBEAT_TTL_MS = 15_000
const ENTRY_KEYS = ["swarm"] as const

const REGISTRY_KEY = Symbol.for("opencode.swarm.instances")

type GlobalWithRegistry = typeof globalThis & { [key: symbol]: unknown }

function instanceRegistry(): Map<string, number> {
  const global = globalThis as GlobalWithRegistry
  const existing = global[REGISTRY_KEY]
  if (existing instanceof Map) return existing
  const created = new Map<string, number>()
  global[REGISTRY_KEY] = created
  return created
}

function heartbeat(instanceID: string): void {
  instanceRegistry().set(instanceID, Date.now())
}

/**
 * Instances alive in this process (fresh heartbeat). This is shared across
 * plugin instances by construction: the v2 plugin SDK hosts every location's
 * plugins in-process on the same binary (the SDK hands them in-process host
 * services, not HTTP clients), so all instances share this globalThis.
 */
function liveProcessInstances(): Set<string> {
  const now = Date.now()
  const set = new Set<string>()
  for (const [id, at] of instanceRegistry()) if (now - at < HEARTBEAT_TTL_MS) set.add(id)
  return set
}

export function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const record = error as Record<string, unknown>
  if (record.name === "Session.NotFoundError" || record._tag === "Session.NotFoundError") return true
  return /not found/i.test(String(record.message ?? error)) && /session/i.test(String(record.message ?? error))
}

export interface CoordinatorOptions {
  readonly store: Store
  readonly client: ServiceClient
  /** Mutable current config; the config watcher swaps it atomically. */
  readonly current: { config: LoadedConfig }
  readonly scopeKey: string
  /** Canonical checkout root of this instance's location (cheap event prefilter). */
  readonly scopeRoot: string
  readonly serviceID: string
  readonly instanceID: string
  readonly session: {
    synthetic(input: {
      id?: string
      sessionID: string
      text: string
      metadata?: Record<string, unknown>
      delivery?: "steer" | "queue"
      resume?: boolean
    }): Promise<unknown>
  }
  readonly log: (level: "info" | "warn" | "error", message: string) => void
}

const NAME_RE = /^[a-zà-öø-ÿ][a-zà-öø-ÿ0-9]*(?:-[1-9][0-9]*)?$/

export class Coordinator {
  private readonly sessionCache = new Map<string, CachedSession>()
  private readonly waits = new Map<string, WaitEntry>()
  private availableChangeAt = 0
  private stopping = false
  private reconcileTimer: ReturnType<typeof setInterval> | undefined
  private retryTimer: ReturnType<typeof setInterval> | undefined
  private waitPollTimer: ReturnType<typeof setInterval> | undefined
  private reconcileRunning = false
  private disabledHandled = false

  constructor(private readonly opts: CoordinatorOptions) {}

  start(): void {
    heartbeat(this.opts.instanceID)
    this.reconcileTimer = setInterval(
      () => {
        void this.reconcileTick().catch((error) => this.opts.log("error", `reconcile tick failed: ${String(error)}`))
      },
      this.opts.current.config.config.presence.reconcileEveryMs,
    )
    this.retryTimer = setInterval(
      () => {
        void this.retryTick().catch((error) => this.opts.log("error", `retry tick failed: ${String(error)}`))
      },
      1_000,
    )
    this.waitPollTimer = setInterval(
      () => this.waitPollTick(),
      this.opts.current.config.config.wait.pollEveryMs,
    )
    // Immediate first pass so restarts rediscover live sessions promptly.
    void this.reconcileTick().catch(() => undefined)
  }

  stop(): void {
    this.stopping = true
    for (const timer of [this.reconcileTimer, this.retryTimer, this.waitPollTimer]) if (timer) clearInterval(timer)
    for (const [id, entry] of [...this.waits.entries()]) {
      this.opts.store.resolveWaitTerminal(id, "cancelled", Date.now())
      this.resolveEntry(id, {
        status: "timeout",
        id: entry.messageID,
        name: entry.name,
        waiting: false,
        detail: "swarm stopped before a reply arrived",
      })
    }
    this.opts.store.releaseOwnership(this.opts.scopeKey, this.opts.instanceID, Date.now())
    this.opts.store.markInstanceDead(this.opts.instanceID, Date.now())
  }

  // --------------------------------------------------------------- sessions

  private scopeOf(session: { projectID: string; location: { directory: string } }): string {
    const input: ScopeInput = { serviceID: this.opts.serviceID, projectID: session.projectID, directory: session.location.directory }
    return scopeKey(input)
  }

  private excludedSession(parentID: string | undefined): boolean {
    return parentID !== undefined && !this.opts.current.config.config.presence.includeSubagents
  }

  private cacheFromList(session: {
    id: string
    parentID?: string
    projectID: string
    location: { directory: string }
    time: { archived?: string }
  }): CachedSession {
    const info: CachedSession = {
      scopeKey: this.scopeOf(session),
      parentID: session.parentID,
      directory: session.location.directory,
      projectID: session.projectID,
      archived: session.time.archived !== undefined,
      deleted: false,
      at: Date.now(),
    }
    this.sessionCache.set(session.id, info)
    return info
  }

  /** Fill the session cache for one id (events may arrive before the list). */
  private async ensureCached(sessionID: string): Promise<CachedSession | undefined> {
    const cached = this.sessionCache.get(sessionID)
    if (cached?.deleted) return cached
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached
    try {
      const session = await this.opts.client.sessionGet(sessionID)
      return this.cacheFromList(session)
    } catch (error) {
      if (error instanceof ServiceError && error.status === 404) {
        const info: CachedSession = {
          scopeKey: this.opts.scopeKey,
          directory: "",
          projectID: "",
          archived: true,
          deleted: true,
          at: Date.now(),
        }
        this.sessionCache.set(sessionID, info)
        return info
      }
      this.opts.log("warn", `session lookup failed for ${sessionID}: ${String(error)}`)
      return cached
    }
  }

  // ---------------------------------------------------------------- events

  onEvent(event: { type: string; data?: Record<string, unknown>; location?: { directory?: string } }): void {
    // Cheap prefilter: events carry the session's location. A directory that
    // is not inside this instance's checkout root cannot be in this scope.
    // Symlink edge cases at most delay an event to the next reconcile tick.
    const directory = event.location?.directory
    if (typeof directory === "string" && !this.scopeRootCandidate(directory)) return
    void this.handleEvent(event)
  }

  private scopeRootCandidate(directory: string): boolean {
    return directory === this.opts.scopeRoot || directory.startsWith(`${this.opts.scopeRoot}/`)
  }

  private async handleEvent(event: { type: string; data?: Record<string, unknown> }): Promise<void> {
    const data = event.data ?? {}
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID) return
    const cfg = this.opts.current.config
    const scope = this.opts.scopeKey
    const now = Date.now()

    switch (event.type) {
      case "session.created": {
        // Publish identity + peers as early as possible: entries that exist
        // before the first prompt is assembled go into the prompt baseline
        // (system area) instead of arriving as a mid-session update. The
        // event payload carries everything needed, so no lookup is required.
        const projectID = typeof data.projectID === "string" ? data.projectID : undefined
        const directory = (data.location as { directory?: unknown } | undefined)?.directory
        const parentID = typeof data.parentID === "string" ? data.parentID : undefined
        if (!projectID || typeof directory !== "string") break
        if (scopeKey({ serviceID: this.opts.serviceID, projectID, directory }) !== scope) break
        if (this.excludedSession(parentID)) break
        if (!this.opts.store.identityFor(scope, sessionID)) {
          const name = this.opts.store.acquireIdentity(scope, sessionID, cfg.files.names, now)
          this.opts.log("info", `identity assigned on creation: ${sessionID} -> ${name}`)
        }
        this.peerSetChanged()
        void this.syncSessionInstructions(sessionID).catch((error) =>
          this.opts.log("warn", `immediate instruction sync failed for ${sessionID}: ${String(error)}`),
        )
        break
      }
      case "session.execution.started": {
        const info = await this.ensureCached(sessionID)
        if (!info || info.deleted || info.scopeKey !== scope || this.excludedSession(info.parentID)) break
        this.opts.store.touchActive(scope, sessionID, now)
        this.opts.store.clearSuspended(scope, sessionID, now)
        if (!this.opts.store.identityFor(scope, sessionID)) {
          const name = this.opts.store.acquireIdentity(scope, sessionID, cfg.files.names, now)
          this.opts.log("info", `identity assigned: ${sessionID} -> ${name}`)
        }
        this.peerSetChanged()
        // Covers sessions created before this instance started (or after a
        // restart with lost entries): publish right away instead of waiting
        // up to one reconcile tick.
        void this.syncSessionInstructions(sessionID).catch((error) =>
          this.opts.log("warn", `immediate instruction sync failed for ${sessionID}: ${String(error)}`),
        )
        break
      }
      case "session.tool.called":
      case "session.shell.started": {
        const info = await this.ensureCached(sessionID)
        if (!info || info.deleted || info.scopeKey !== scope || this.excludedSession(info.parentID)) break
        this.opts.store.touchActive(scope, sessionID, now)
        break
      }
      case "session.execution.succeeded":
      case "session.execution.failed": {
        const info = await this.ensureCached(sessionID)
        if (!info || info.deleted || info.scopeKey !== scope) break
        this.opts.store.markIdle(scope, sessionID, now)
        this.peerSetChanged()
        break
      }
      case "session.execution.interrupted": {
        const info = await this.ensureCached(sessionID)
        if (!info || info.deleted || info.scopeKey !== scope) break
        if (data.reason === "user") {
          this.opts.store.markSuspended(scope, sessionID, now)
          this.opts.log("info", `user stopped ${sessionID}; marked suspended until next real work`)
        } else {
          this.opts.store.markIdle(scope, sessionID, now)
        }
        this.peerSetChanged()
        break
      }
      case "session.archived":
      case "session.deleted": {
        const info = await this.ensureCached(sessionID)
        if (!info || info.scopeKey !== scope) break
        this.opts.store.tombstoneIdentity(scope, sessionID, now)
        this.opts.store.removePresence(scope, sessionID)
        this.opts.store.removeInstructionState(scope, sessionID)
        void this.removeEntries(sessionID).catch(() => undefined)
        this.peerSetChanged()
        break
      }
      case "session.moved":
      case "session.forked":
      case "session.renamed": {
        this.sessionCache.delete(sessionID)
        break
      }
      case "session.compaction.ended": {
        const info = await this.ensureCached(sessionID)
        if (!info || info.scopeKey !== scope) break
        void this.reverifyEntries(sessionID).catch((error) => this.opts.log("warn", `entry re-verify failed: ${String(error)}`))
        break
      }
      default:
        return
    }
  }

  private peerSetChanged(): void {
    this.availableChangeAt = Date.now()
  }

  // ---------------------------------------------------------- reconcile loop

  private async reconcileTick(): Promise<void> {
    if (this.stopping || this.reconcileRunning) return
    this.reconcileRunning = true
    try {
      await this.reconcileInner()
    } finally {
      this.reconcileRunning = false
    }
  }

  private async reconcileInner(): Promise<void> {
    heartbeat(this.opts.instanceID)
    const cfg = this.opts.current.config
    const scope = this.opts.scopeKey
    const now = Date.now()
    const leaseMs = Math.max(3 * cfg.config.presence.reconcileEveryMs, 10_000)

    if (!cfg.config.enabled) {
      if (!this.disabledHandled) this.handleDisable()
      return
    }
    this.disabledHandled = false

    const ownsLease = this.opts.store.acquireOwnership(scope, this.opts.instanceID, now, leaseMs)

    try {
      const [active, sessions] = await Promise.all([this.opts.client.sessionActive(), this.opts.client.listSessions()])
      const byId = new Map(sessions.map((session) => [session.id, session]))

      for (const id of active) {
        const listed = byId.get(id)
        const info = listed ? this.cacheFromList(listed) : this.sessionCache.get(id)
        if (!info || info.deleted || info.archived) continue
        if (info.scopeKey !== scope || this.excludedSession(info.parentID)) continue
        this.opts.store.touchActive(scope, id, now)
        this.opts.store.clearSuspended(scope, id, now)
        if (!this.opts.store.identityFor(scope, id)) {
          const name = this.opts.store.acquireIdentity(scope, id, cfg.files.names, now)
          this.opts.log("info", `identity (re)discovered in reconcile: ${id} -> ${name}`)
        }
        this.peerSetChanged()
      }

      for (const row of this.opts.store.presenceAll(scope)) {
        if (active.has(row.sessionID)) continue
        if (row.idleSince === null && !row.suspended) {
          this.opts.store.markIdle(scope, row.sessionID, now)
          this.peerSetChanged()
        }
      }

      for (const session of sessions) {
        const info = this.cacheFromList(session)
        if (info.scopeKey !== scope) continue
        if (info.archived) {
          this.opts.store.tombstoneIdentity(scope, session.id, now)
          this.opts.store.removePresence(scope, session.id)
          this.opts.store.removeInstructionState(scope, session.id)
          void this.removeEntries(session.id).catch(() => undefined)
        }
      }

      const live = liveProcessInstances()
      live.add(this.opts.instanceID)
      for (const instance of this.opts.store.liveOwners(now).values()) live.add(instance)
      const reaped = this.opts.store.reapOrphanWaits(scope, live, now)
      if (reaped > 0) this.opts.log("warn", `reaped ${reaped} orphan wait(s) with dead owners`)
    } catch (error) {
      // Failed activity queries keep the previous state (no mass expire).
      this.opts.log("warn", `reconcile query failed, keeping state: ${String(error)}`)
    }

    if (ownsLease) {
      try {
        await this.syncInstructions()
      } catch (error) {
        this.opts.log("warn", `instruction sync failed: ${String(error)}`)
      }
    }
  }

  private handleDisable(): void {
    this.disabledHandled = true
    const scope = this.opts.scopeKey
    const now = Date.now()
    for (const [id, entry] of [...this.waits.entries()]) {
      this.opts.store.resolveWaitTerminal(id, "cancelled", now)
      this.resolveEntry(id, {
        status: "timeout",
        id: entry.messageID,
        name: entry.name,
        waiting: false,
        detail: "swarm was disabled while waiting",
      })
    }
    for (const identity of this.opts.store.identitiesAll(scope)) {
      void this.removeEntries(identity.sessionID).catch(() => undefined)
    }
    this.opts.log("info", "swarm disabled: waits cancelled, entries removed")
  }

  // -------------------------------------------------------- instructions sync

  private async syncInstructions(): Promise<void> {
    const cfg = this.opts.current.config
    const scope = this.opts.scopeKey
    const now = Date.now()
    const identities = this.opts.store.identitiesAll(scope)
    const nameOf = new Map(identities.map((identity) => [identity.sessionID, identity.name]))
    const available = this.opts.store.availableSessions(scope, now, cfg.config.presence.idleGraceMs)

    for (const identity of identities) {
      if (identity.tombstone) continue
      await this.publishSessionEntries(identity, { nameOf, available, cfg, now })
    }
  }

  /**
   * Publish one session's entries outside the reconcile tick so the in-flight
   * (or next) turn can carry them in the prompt baseline instead of waiting
   * up to one tick (and the peers debounce) for the next reconciliation.
   */
  private async syncSessionInstructions(sessionID: string): Promise<void> {
    const cfg = this.opts.current.config
    const scope = this.opts.scopeKey
    const now = Date.now()
    const identity = this.opts.store.identityFor(scope, sessionID)
    if (!identity || identity.tombstone) return
    const identities = this.opts.store.identitiesAll(scope)
    const nameOf = new Map(identities.map((item) => [item.sessionID, item.name]))
    const available = this.opts.store.availableSessions(scope, now, cfg.config.presence.idleGraceMs)
    await this.publishSessionEntries(identity, { nameOf, available, cfg, now, bypassPeersDebounce: true })
  }

  private async publishSessionEntries(
    identity: Identity,
    args: {
      nameOf: Map<string, string>
      available: Iterable<string>
      cfg: LoadedConfig
      now: number
      bypassPeersDebounce?: boolean
    },
  ): Promise<void> {
    const scope = this.opts.scopeKey
    const peers: string[] = []
    for (const sessionID of args.available) {
      if (sessionID === identity.sessionID) continue
      const name = args.nameOf.get(sessionID)
      if (name) peers.push(name)
    }
    peers.sort()
    // One entry, value is a plain string: the core renders string values
    // verbatim, so the model sees the <swarm> block below (inside the core's
    // own <context key="swarm"> wrapper). desiredJson keeps the JSON encoding
    // so the re-verify hash matches the server-side round trip.
    const desired: Array<[string, string]> = [
      ["swarm", JSON.stringify(renderSwarmContext(identity.name, peers, renderPrompt(args.cfg.files.prompt, identity.name)))],
    ]
    for (const [key, json] of desired) {
      const hash = sha256(json)
      const state = this.opts.store.instructionState(scope, identity.sessionID, key)
      if (state && state.desiredHash === hash) {
        if (state.confirmedHash === hash) continue
      } else {
        this.opts.store.setInstructionDesired(scope, identity.sessionID, key, json, args.now)
      }
      if (key === "swarm" && !args.bypassPeersDebounce && args.now - this.availableChangeAt < args.cfg.config.presence.publishDebounceMs) continue
      try {
        await this.opts.client.instructionsPut(identity.sessionID, key, JSON.parse(json))
        this.opts.store.confirmInstruction(scope, identity.sessionID, key, hash, args.now)
      } catch (error) {
        if (error instanceof ServiceError && error.status === 404) continue
        this.opts.log("warn", `instruction put failed for ${identity.sessionID} ${key}: ${String(error)}`)
      }
    }
  }

  private async removeEntries(sessionID: string): Promise<void> {
    for (const key of ENTRY_KEYS) {
      try {
        await this.opts.client.instructionsRemove(sessionID, key)
      } catch (error) {
        if (error instanceof ServiceError && error.status === 404) return
      }
    }
  }

  private async reverifyEntries(sessionID: string): Promise<void> {
    const scope = this.opts.scopeKey
    const rows = this.opts.store.instructionRows(scope, sessionID)
    let entries: readonly { key: string; value: unknown }[]
    try {
      entries = await this.opts.client.instructionsList(sessionID)
    } catch (error) {
      if (error instanceof ServiceError && error.status === 404) return
      throw error
    }
    const listed = new Map(entries.map((entry) => [entry.key, entry.value]))
    for (const row of rows) {
      const value = listed.get(row.key)
      const hash = value === undefined ? undefined : sha256(JSON.stringify(value))
      if (hash === row.desiredHash) {
        this.opts.store.confirmInstruction(scope, sessionID, row.key, hash, Date.now())
        continue
      }
      try {
        await this.opts.client.instructionsPut(sessionID, row.key, JSON.parse(row.desiredJson))
        this.opts.store.confirmInstruction(scope, sessionID, row.key, row.desiredHash, Date.now())
      } catch (error) {
        if (error instanceof ServiceError && error.status === 404) return
        this.opts.log("warn", `entry re-verify failed for ${sessionID} ${row.key}: ${String(error)}`)
      }
    }
  }

  // ------------------------------------------------------------------ sends

  async handleSend(input: SwarmSendInput, call: CallContext): Promise<SwarmResult> {
    const cfg = this.opts.current.config
    const scope = this.opts.scopeKey

    if (!cfg.config.enabled) return { status: "error", code: "CONFIG_ERROR", detail: "swarm is disabled" }
    if (typeof input.name !== "string" || !NAME_RE.test(input.name) || input.name.length > 64)
      return { status: "error", code: "INVALID_INPUT", detail: "name must match the peer name pattern (lowercase Latin letters, digits and accents, optional -N suffix)" }
    if (typeof input.message !== "string" || input.message.trim().length === 0)
      return { status: "error", code: "INVALID_INPUT", detail: "message must be non-empty text" }
    const messageBytes = Buffer.byteLength(input.message, "utf8")
    if (messageBytes > cfg.config.limits.messageMaxBytes)
      return { status: "error", code: "INVALID_INPUT", detail: `message exceeds ${cfg.config.limits.messageMaxBytes} bytes (got ${messageBytes})` }
    const reply = input.reply_to === undefined ? undefined : input.reply_to
    if (reply !== undefined && (typeof reply !== "string" || !/^msg_[A-Za-z0-9]+$/.test(reply)))
      return { status: "error", code: "INVALID_REPLY", detail: "reply_to must be the exact opaque message ID received" }
    const waiting = input.wait_for_reply === true

    // Real caller identity from the invocation context, never an argument.
    const caller = call.sessionID
    const callerInfo = await this.ensureCached(caller)
    if (!callerInfo || callerInfo.deleted || callerInfo.scopeKey !== scope)
      return { status: "error", code: "OUT_OF_SCOPE", detail: "caller session is not inside this workspace scope" }
    if (this.excludedSession(callerInfo.parentID))
      return { status: "error", code: "OUT_OF_SCOPE", detail: "subagent sessions do not participate by default" }

    let selfIdentity = this.opts.store.identityFor(scope, caller)
    if (!selfIdentity) {
      const name = this.opts.store.acquireIdentity(scope, caller, cfg.files.names, Date.now())
      selfIdentity = { scopeKey: scope, sessionID: caller, name, tombstone: false }
    }
    if (selfIdentity.tombstone)
      return { status: "error", code: "OUT_OF_SCOPE", detail: "this session was archived; its name is reserved" }
    const selfName = selfIdentity.name

    // Target resolution.
    const target = this.opts.store.identityByName(scope, input.name)
    if (target && target.sessionID === caller) return { status: "error", code: "SELF_SEND", detail: `you are "${selfName}"` }
    if (reply !== undefined) {
      const original = this.opts.store.message(reply)
      if (!original || original.scopeKey !== scope)
        return { status: "error", code: "INVALID_REPLY", detail: "reply ID is not a message of this workspace" }
      if (original.toSessionID !== caller)
        return { status: "error", code: "INVALID_REPLY", detail: "the original message was not addressed to you" }
      if (!target || target.tombstone || target.sessionID !== original.fromSessionID)
        return {
          status: "error",
          code: "INVALID_REPLY",
          detail: 'name must identify the original author ("' + (target ? target.name : input.name) + '" does not match the original sender)',
        }
      const targetInfo = await this.ensureCached(target.sessionID)
      if (!targetInfo || targetInfo.deleted || targetInfo.archived)
        return { status: "error", code: "PEER_UNAVAILABLE", detail: "the original author is no longer in this workspace" }
      if (targetInfo.scopeKey !== scope)
        return { status: "error", code: "PEER_UNAVAILABLE", detail: "the original author moved to another workspace" }
      const presence = this.opts.store.presenceFor(scope, target.sessionID)
      if (presence?.suspended)
        return { status: "error", code: "PEER_UNAVAILABLE", detail: "the original author was stopped by the user and stays suspended" }
    } else {
      if (!target || target.tombstone)
        return { status: "error", code: "PEER_UNAVAILABLE", detail: `no available peer named "${input.name}"`, peers: this.availableNames(caller) }
      const targetInfo = await this.ensureCached(target.sessionID)
      if (!targetInfo || targetInfo.deleted || targetInfo.archived)
        return { status: "error", code: "PEER_UNAVAILABLE", detail: `peer "${input.name}" is no longer in this workspace`, peers: this.availableNames(caller) }
      if (targetInfo.scopeKey !== scope)
        return { status: "error", code: "PEER_UNAVAILABLE", detail: `peer "${input.name}" moved to another workspace`, peers: this.availableNames(caller) }
      const available = this.opts.store.availableSessions(scope, Date.now(), cfg.config.presence.idleGraceMs)
      if (!available.has(target.sessionID))
        return { status: "error", code: "PEER_UNAVAILABLE", detail: `peer "${input.name}" is not currently available`, peers: this.availableNames(caller) }
    }

    // Rate limits: separate sliding windows for sends and replies.
    const now = Date.now()
    if (reply !== undefined) {
      const used = this.opts.store.countSince(scope, caller, now - 60_000, true)
      if (used >= cfg.config.limits.repliesPerMinutePerSession)
        return { status: "error", code: "RATE_LIMITED", detail: `reply_to limit reached (${cfg.config.limits.repliesPerMinutePerSession}/min)` }
    } else {
      const used = this.opts.store.countSince(scope, caller, now - 60_000, false)
      if (used >= cfg.config.limits.sendsPerMinutePerSession)
        return { status: "error", code: "RATE_LIMITED", detail: `send limit reached (${cfg.config.limits.sendsPerMinutePerSession}/min)` }
    }

    const targetIdentity = target as NonNullable<typeof target>
    const envelope: Envelope = {
      protocol: "swarm/v1",
      id: newMessageID(now),
      scopeKey: scope,
      fromSessionID: caller,
      toSessionID: targetIdentity.sessionID,
      fromName: selfName,
      toName: targetIdentity.name,
      message: input.message,
      reply,
      createdAt: new Date(now).toISOString(),
    }
    const invocation = invocationKey(caller, call.messageID, call.callID)
    const inputHash = sha256Of({ name: input.name, message: input.message, reply, wait_for_reply: waiting })
    const waitRequest = waiting
      ? { id: newWaitID(), durationMs: cfg.config.wait.timeoutMs, ownerInstance: this.opts.instanceID }
      : null
    const committed = this.opts.store.commitSend({ id: envelope.id, envelope, invocation, inputHash, wait: waitRequest, now })

    if (committed.status === "conflict")
      return { status: "error", code: "IDEMPOTENCY_CONFLICT", detail: "this invocation was already recorded with different input" }
    if (committed.status === "exists")
      return this.reconcileExisting(committed.existing as MessageRow, { reply, waiting }, selfName)

    if (committed.cycle) {
      // The question is still sent; only the wait is dropped (W06/W07/W08).
      const cyclePath = this.opts.store.pathBetween(scope, targetIdentity.sessionID, caller)
      const result = await this.dispatch(envelope, { reply, waiting: false }, undefined, selfName, targetIdentity.name, call)
      if (result.status === "accepted")
        return {
          ...result,
          reason: "cycle_detected",
          detail: `waiting would close a wait cycle (${cyclePath?.join(" -> ") ?? "a chain of pending waits"}); sent without waiting`,
        }
      return result
    }

    return this.dispatch(envelope, { reply, waiting }, committed.waitID, selfName, targetIdentity.name, call)
  }

  private availableNames(excludeSession: string): string[] {
    const cfg = this.opts.current.config
    const available = this.opts.store.availableSessions(this.opts.scopeKey, Date.now(), cfg.config.presence.idleGraceMs)
    const names: string[] = []
    for (const sessionID of available) {
      if (sessionID === excludeSession) continue
      const identity = this.opts.store.identityFor(this.opts.scopeKey, sessionID)
      if (identity && !identity.tombstone) names.push(identity.name)
    }
    return names.sort()
  }

  private async reconcileExisting(
    existing: MessageRow,
    flags: { reply?: string; waiting: boolean },
    selfName: string,
  ): Promise<SwarmResult> {
    const scope = this.opts.scopeKey
    if (existing.state === "failed")
      return { status: "error", code: "PEER_UNAVAILABLE", detail: `previous attempt failed: ${existing.lastError ?? "unknown"}` }
    if (existing.state === "unknown") {
      const withinWindow = Date.now() - existing.createdAt <= this.opts.current.config.config.delivery.retryWindowMs
      if (!withinWindow)
        return {
          status: "delivery_unknown",
          id: existing.id,
          name: existing.toName,
          waiting: false,
          detail: "admission could not be confirmed within the retry window; the send may or may not have been delivered",
        }
      // inside the window: re-dispatch below with the same ID
    }
    if (existing.state === "admitted") {
      if (!flags.waiting) return { status: "accepted", id: existing.id, name: existing.toName, waiting: false }
      const live = this.opts.store.liveWaitForMessage(scope, existing.id)
      if (live) {
        return new Promise<SwarmResult>((resolve) => this.attach(live.id, existing, resolve))
      }
      const terminal = this.opts.store.anyWaitForMessage(scope, existing.id)
      if (terminal) return this.resultFromWait(terminal, existing)
      return { status: "accepted", id: existing.id, name: existing.toName, waiting: false }
    }
    // pending, or unknown inside the window: re-dispatch with the same ID.
    const envelope = envelopeFromRow(existing)
    return this.dispatch(
      envelope,
      flags,
      this.opts.store.liveWaitForMessage(scope, existing.id)?.id,
      selfName,
      existing.toName,
      { sessionID: existing.fromSessionID, messageID: "", callID: "", signal: new AbortController().signal },
    )
  }

  private async dispatch(
    envelope: Envelope,
    flags: { reply?: string; waiting: boolean },
    waitID: string | undefined,
    selfName: string,
    targetName: string,
    call: CallContext,
  ): Promise<SwarmResult> {
    const cfg = this.opts.current.config
    const scope = this.opts.scopeKey
    const original = flags.reply ? this.opts.store.message(flags.reply) : undefined
    const text = renderOutbound(envelope, original?.body, cfg.config.limits.replyQuoteMaxChars)
    const metadata = envelopeMetadata(envelope)
    const admissionTimeout = cfg.config.delivery.admissionTimeoutMs

    let admitted = false
    let notFound = false
    try {
      await withTimeout(
        this.opts.session.synthetic({
          id: envelope.id,
          sessionID: envelope.toSessionID,
          text,
          metadata,
          delivery: "steer",
          resume: true,
        }),
        admissionTimeout,
      )
      admitted = true
    } catch (error) {
      if (isNotFoundError(error)) notFound = true
      else this.opts.log("warn", `admission uncertain for ${envelope.id}: ${String(error)}`)
    }

    if (admitted) {
      const now = Date.now()
      this.opts.store.setAdmitted(envelope.id)
      if (waitID) this.opts.store.setWaiting(waitID, now + cfg.config.wait.timeoutMs, now)
      // W11: a reply that also waits resolves the satisfied edge first.
      let claimed: WaitRow | undefined
      if (flags.reply) {
        claimed = this.opts.store.claimReplyWait(scope, flags.reply, envelope.id, now)
        if (claimed) this.resolveWait(claimed)
      }
      if (flags.reply && !claimed) await this.deliverReply(envelope, original?.body ?? "")
      if (flags.waiting && waitID) {
        if (call.progress) {
          try {
            await call.progress({ swarm: "waiting", peer: targetName, message: envelope.id })
          } catch {
            // progress is best-effort
          }
        }
        return this.waitForResult(waitID, envelope, targetName, call)
      }
      return { status: "accepted", id: envelope.id, name: targetName, waiting: false }
    }

    if (notFound) {
      this.opts.store.setFailed(envelope.id, "peer session not found")
      if (waitID) this.opts.store.resolveWaitTerminal(waitID, "cancelled", Date.now())
      return {
        status: "error",
        code: "PEER_UNAVAILABLE",
        detail: "peer session is not reachable (moved or deleted)",
        peers: this.availableNames(envelope.fromSessionID),
      }
    }

    // Admission uncertain: keep reconciling, abandon the tool wait.
    this.opts.store.setUnknown(envelope.id, "admission attempt failed")
    const attempts = this.opts.store.message(envelope.id)?.attempts ?? 0
    this.opts.store.recordAttempt(envelope.id, nextBackoffAt(cfg.config.delivery, attempts))
    if (waitID) this.opts.store.resolveWaitTerminal(waitID, "abandoned", Date.now())
    return {
      status: "delivery_unknown",
      id: envelope.id,
      name: targetName,
      waiting: false,
      detail: `admission could not be confirmed within ${admissionTimeout}ms; the plugin keeps reconciling this send`,
    }
  }

  // ------------------------------------------------------------------ waits

  private attach(waitID: string, existing: MessageRow, resolve: (result: SwarmResult) => void): void {
    const entry = this.waits.get(waitID) ?? { name: existing.toName, messageID: existing.id, resolves: new Set() }
    entry.resolves.add(resolve)
    this.waits.set(waitID, entry)
  }

  private resolveEntry(waitID: string, result: SwarmResult): void {
    const entry = this.waits.get(waitID)
    if (!entry) return
    this.waits.delete(waitID)
    for (const resolve of entry.resolves) resolve(result)
  }

  private removeResolver(waitID: string, resolve: (result: SwarmResult) => void): void {
    const entry = this.waits.get(waitID)
    if (!entry) return
    entry.resolves.delete(resolve)
    if (entry.resolves.size === 0) this.waits.delete(waitID)
  }

  private waitForResult(waitID: string, envelope: Envelope, targetName: string, call: CallContext): Promise<SwarmResult> {
    return new Promise<SwarmResult>((resolve) => {
      const onAbort = () => {
        this.opts.store.resolveWaitTerminal(waitID, "cancelled", Date.now())
        this.removeResolver(waitID, resolve)
        resolve({
          status: "timeout",
          id: envelope.id,
          name: targetName,
          waiting: false,
          detail: "wait cancelled by the caller",
        })
      }
      if (call.signal.aborted) {
        onAbort()
        return
      }
      call.signal.addEventListener("abort", onAbort, { once: true })
      this.attach(
        waitID,
        { id: envelope.id, toName: targetName } as unknown as MessageRow,
        (result) => {
          call.signal.removeEventListener("abort", onAbort)
          resolve(result)
        },
      )
    })
  }

  private waitPollTick(): void {
    if (this.waits.size === 0) return
    const now = Date.now()
    for (const [waitID, entry] of [...this.waits.entries()]) {
      const wait = this.opts.store.wait(waitID)
      if (!wait) {
        this.resolveEntry(waitID, {
          status: "timeout",
          id: entry.messageID,
          name: entry.name,
          waiting: false,
          detail: "wait record lost",
        })
        continue
      }
      if (wait.state === "replied") {
        this.resolveEntry(waitID, this.resultFromWait(wait, this.opts.store.message(wait.messageID)))
        continue
      }
      if (wait.state === "timed_out") {
        this.resolveEntry(waitID, this.timeoutResult(wait, entry))
        continue
      }
      if (wait.state === "cancelled" || wait.state === "abandoned") {
        this.resolveEntry(waitID, {
          status: "timeout",
          id: entry.messageID,
          name: entry.name,
          waiting: false,
          detail: `wait ${wait.state} before a reply arrived`,
        })
        continue
      }
      if (wait.deadlineAt !== null && now >= wait.deadlineAt) {
        const { won, row } = this.opts.store.transitionWait(waitID, ["reserved", "waiting"], "timed_out", null, now)
        if (won || row?.state === "timed_out") this.resolveEntry(waitID, this.timeoutResult(wait, entry))
        // If the reply won the race, the next tick resolves with "replied".
      }
    }
  }

  private timeoutResult(wait: WaitRow, entry: { name: string; messageID: string }): SwarmResult {
    return {
      status: "timeout",
      id: entry.messageID,
      name: entry.name,
      waiting: false,
      detail: `no reply within ${Math.round(wait.durationMs / 1000)}s; the message stays sent and a late reply will arrive as a message`,
    }
  }

  /**
   * A reply was persisted and claimed a live wait. If this process holds the
   * waiter's promise, resolve it directly (no synthetic copy to the author).
   * Otherwise the reply goes through the async channel so it is never lost.
   */
  private resolveWait(claimed: WaitRow): void {
    if (this.waits.has(claimed.id)) {
      const entry = this.waits.get(claimed.id)!
      this.resolveEntry(claimed.id, this.resultFromWait(claimed, this.opts.store.message(claimed.messageID)))
      return
    }
    const now = Date.now()
    const owners = this.opts.store.liveOwners(now)
    const live =
      liveProcessInstances().has(claimed.ownerInstance) || [...owners.values()].includes(claimed.ownerInstance)
    if (live) return // another live instance owns the promise and polls it
    void this.deliverReplyForWait(claimed).catch((error) =>
      this.opts.log("warn", `async delivery failed for wait ${claimed.id}: ${String(error)}`),
    )
  }

  private async deliverReplyForWait(claimed: WaitRow): Promise<void> {
    if (!claimed.replyMessageID) return
    const reply = this.opts.store.message(claimed.replyMessageID)
    if (!reply) return
    await this.deliverReply(envelopeFromRow(reply), this.opts.store.message(claimed.messageID)?.body ?? "")
  }

  private async deliverReply(envelope: Envelope, originalBody: string): Promise<void> {
    const cfg = this.opts.current.config
    const scope = envelope.scopeKey
    const target = this.opts.store.identityFor(scope, envelope.toSessionID)
    if (!target || target.tombstone) return
    const presence = this.opts.store.presenceFor(scope, envelope.toSessionID)
    if (presence?.suspended) {
      this.opts.log("info", `reply ${envelope.id} retained: recipient ${envelope.toSessionID} is suspended`)
      return
    }
    const info = this.sessionCache.get(envelope.toSessionID)
    if (info?.archived || info?.deleted) return
    const text = renderOutbound(envelope, originalBody, cfg.config.limits.replyQuoteMaxChars)
    try {
      await this.opts.session.synthetic({
        id: envelope.id,
        sessionID: envelope.toSessionID,
        text,
        metadata: envelopeMetadata(envelope),
        delivery: "steer",
        resume: true,
      })
      this.opts.log("info", `reply ${envelope.id} delivered to ${envelope.toSessionID}`)
    } catch (error) {
      if (isNotFoundError(error)) {
        this.opts.log("info", `reply ${envelope.id} retained: recipient no longer reachable`)
        return
      }
      this.opts.log("warn", `reply delivery failed for ${envelope.id}: ${String(error)}`)
    }
  }

  private resultFromWait(wait: WaitRow, original: MessageRow | undefined): SwarmResult {
    if (wait.state === "replied" && wait.replyMessageID) {
      const reply = this.opts.store.message(wait.replyMessageID)
      if (reply) {
        const cfg = this.opts.current.config
        return {
          status: "replied",
          id: original?.id ?? wait.messageID,
          name: reply.fromName,
          waiting: false,
          response: {
            id: reply.id,
            from: reply.fromName,
            reply_to: reply.replyTo ?? "",
            message: reply.body,
          },
        }
      }
    }
    return this.timeoutResult(wait, { name: original?.toName ?? "", messageID: wait.messageID })
  }

  // ----------------------------------------------------------------- retries

  private async retryTick(): Promise<void> {
    const cfg = this.opts.current.config
    if (!cfg.config.enabled) return
    const scope = this.opts.scopeKey
    const now = Date.now()
    const window = cfg.config.delivery.retryWindowMs

    for (const row of this.opts.store.dueRetries(scope, now, window)) {
      if (row.createdAt + window < now) continue
      const envelope = envelopeFromRow(row)
      const original = row.replyTo ? this.opts.store.message(row.replyTo) : undefined
      const text = renderOutbound(envelope, original?.body, cfg.config.limits.replyQuoteMaxChars)
      try {
        await withTimeout(
          this.opts.session.synthetic({
            id: envelope.id,
            sessionID: envelope.toSessionID,
            text,
            metadata: envelopeMetadata(envelope),
            delivery: "steer",
            resume: true,
          }),
          cfg.config.delivery.admissionTimeoutMs,
        )
        this.opts.store.setAdmitted(envelope.id)
        if (row.replyTo) {
          const claimed = this.opts.store.claimReplyWait(scope, row.replyTo, envelope.id, now)
          if (claimed) this.resolveWait(claimed)
          else await this.deliverReply(envelope, original?.body ?? "")
        }
        this.opts.log("info", `reconciled admission for ${envelope.id} on attempt ${row.attempts + 1}`)
      } catch (error) {
        if (isNotFoundError(error)) {
          this.opts.store.setFailed(envelope.id, "peer session not found")
          const wait = this.opts.store.liveWaitForMessage(scope, envelope.id)
          if (wait) this.opts.store.resolveWaitTerminal(wait.id, "cancelled", now)
          continue
        }
        this.opts.store.recordAttempt(envelope.id, nextBackoffAt(cfg.config.delivery, row.attempts))
      }
    }

    // Wait reservations whose send exhausted the admission window: abandon so
    // the tool promise can settle (W14).
    for (const row of this.opts.store.expiredRetries(scope, now, window)) {
      const wait = this.opts.store.liveWaitForMessage(scope, row.id)
      if (wait) {
        this.opts.store.resolveWaitTerminal(wait.id, "abandoned", now)
        this.opts.log("warn", `admission window expired for ${row.id}; wait abandoned`)
      }
    }
  }
}

function nextBackoffAt(
  delivery: { retryBaseMs: number; retryMaxMs: number; retryWindowMs: number },
  attempts: number,
): number | null {
  const backoff = Math.min(delivery.retryMaxMs, delivery.retryBaseMs * 2 ** Math.min(attempts, 10))
  const next = Date.now() + backoff
  if (next > Date.now() + delivery.retryWindowMs) return null
  return next
}

function envelopeFromRow(row: MessageRow): Envelope {
  return {
    protocol: "swarm/v1",
    id: row.id,
    scopeKey: row.scopeKey,
    fromSessionID: row.fromSessionID,
    toSessionID: row.toSessionID,
    fromName: row.fromName,
    toName: row.toName,
    message: row.body,
    reply: row.replyTo ?? undefined,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
