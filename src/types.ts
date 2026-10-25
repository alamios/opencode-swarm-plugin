// Shared types for the swarm plugin. No OpenCode imports here so the domain
// modules stay testable outside the host runtime.

export interface SwarmConfig {
  readonly version: 1
  readonly enabled: boolean
  readonly namesFile: string
  readonly promptFile: string
  readonly toolDescriptionFile: string
  readonly presence: {
    readonly idleGraceMs: number
    readonly reconcileEveryMs: number
    readonly publishDebounceMs: number
    readonly includeSubagents: boolean
  }
  readonly wait: {
    readonly timeoutMs: number
    readonly cyclePolicy: "send_async"
    readonly pollEveryMs: number
  }
  readonly limits: {
    readonly messageMaxBytes: number
    readonly replyQuoteMaxChars: number
    readonly sendsPerMinutePerSession: number
    readonly repliesPerMinutePerSession: number
  }
  readonly delivery: {
    readonly admissionTimeoutMs: number
    readonly retryBaseMs: number
    readonly retryMaxMs: number
    readonly retryWindowMs: number
  }
  readonly reload: {
    readonly enabled: boolean
    readonly debounceMs: number
  }
}

export interface SwarmFiles {
  readonly names: readonly string[]
  readonly prompt: string
  readonly toolDescription: string
}

export interface LoadedConfig {
  readonly config: SwarmConfig
  readonly files: SwarmFiles
  /** Absolute path of swarm.json, used to resolve relative file references. */
  readonly configPath: string
}

/** Stable per-scope identity row. */
export interface Identity {
  readonly scopeKey: string
  readonly sessionID: string
  readonly name: string
  readonly tombstone: boolean
}

/** Presence row for one session in one scope. */
export interface PresenceRow {
  readonly scopeKey: string
  readonly sessionID: string
  /** Epoch ms of last observed real activity; null if never active. */
  readonly lastActiveAt: number | null
  /** Epoch ms when the session went idle; null while it is running. */
  readonly idleSince: number | null
  /** True after an explicit user stop until the next real work starts. */
  readonly suspended: boolean
  /** Epoch ms of the last successful reconciliation of this row. */
  readonly lastReconciledAt: number | null
}

export interface Envelope {
  readonly protocol: "swarm/v1"
  readonly id: string
  readonly scopeKey: string
  readonly fromSessionID: string
  readonly toSessionID: string
  readonly fromName: string
  readonly toName: string
  readonly message: string
  readonly reply?: string
  readonly createdAt: string
}

/** Message row persisted by the plugin. */
export interface MessageRow {
  readonly id: string
  readonly scopeKey: string
  readonly fromSessionID: string
  readonly toSessionID: string
  readonly fromName: string
  readonly toName: string
  readonly body: string
  /** ID of the original message when this message is a reply. */
  readonly replyTo: string | null
  readonly createdAt: number
  readonly state: "pending" | "admitted" | "failed" | "unknown"
  /** Invocation identity that produced the message: session|assistantMessage|call. */
  readonly invocation: string
  readonly inputHash: string
  readonly attempts: number
  readonly nextAttemptAt: number | null
  readonly lastError: string | null
}

export type WaitState = "reserved" | "waiting" | "replied" | "timed_out" | "cancelled" | "abandoned"

export interface WaitRow {
  readonly id: string
  readonly scopeKey: string
  readonly messageID: string
  /** The session waiting for a reply (A). */
  readonly fromSessionID: string
  /** The session expected to reply (B). */
  readonly toSessionID: string
  readonly state: WaitState
  readonly createdAt: number
  /** Wall-clock deadline used across restarts. */
  readonly deadlineAt: number | null
  /** Duration in ms captured for this wait at start. */
  readonly durationMs: number
  readonly replyMessageID: string | null
  readonly resolvedAt: number | null
  /** Plugin instance that owns this wait, for orphan reaping. */
  readonly ownerInstance: string
}

export interface InstructionStateRow {
  readonly scopeKey: string
  readonly sessionID: string
  readonly key: string
  readonly desiredJson: string
  readonly desiredHash: string
  readonly confirmedHash: string | null
  readonly updatedAt: number
}

/** Structured result of a swarm call, serialized into tool content. */
export type SwarmResult =
  | {
      readonly status: "accepted"
      readonly id: string
      readonly name: string
      readonly waiting: false
      readonly reason?: "cycle_detected"
      readonly detail?: string
    }
  | {
      readonly status: "replied"
      readonly id: string
      readonly name: string
      readonly waiting: false
      readonly response: { readonly id: string; readonly from: string; readonly reply_to: string; readonly message: string }
    }
  | { readonly status: "timeout"; readonly id: string; readonly name: string; readonly waiting: false; readonly detail: string }
  | { readonly status: "delivery_unknown"; readonly id: string; readonly name: string; readonly waiting: false; readonly detail: string }
  | { readonly status: "error"; readonly code: string; readonly detail: string; readonly peers?: readonly string[] }

export type SwarmErrorCode =
  | "INVALID_INPUT"
  | "PEER_UNAVAILABLE"
  | "OUT_OF_SCOPE"
  | "SELF_SEND"
  | "INVALID_REPLY"
  | "RATE_LIMITED"
  | "CONFIG_ERROR"
  | "UNSUPPORTED_RUNTIME"
  | "IDEMPOTENCY_CONFLICT"
