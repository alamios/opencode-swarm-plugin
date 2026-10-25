// ID generation. Message IDs must be compatible with Session.Message.ID
// (schema check: starts with "msg_"). Uniqueness comes from a time prefix
// plus 14 base62 random characters (~83 bits).

import { createHash, randomBytes } from "node:crypto"
import { randomUUID } from "node:crypto"

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function randomBase62(count: number): string {
  const bytes = randomBytes(count)
  let out = ""
  for (const byte of bytes) out += BASE62[byte % 62]
  return out
}

/** New opaque message ID, compatible with Session.Message.ID. */
export function newMessageID(now = Date.now()): string {
  const time = now.toString(16).padStart(12, "0").slice(-12)
  return `msg_${time}${randomBase62(14)}`
}

/** New wait/invocation ID (internal, not exposed to OpenCode IDs). */
export function newWaitID(): string {
  return `w_${Date.now().toString(16)}_${randomUUID().slice(0, 12)}`
}

/** New plugin instance identity, stable for the lifetime of one load. */
export function newInstanceID(): string {
  return `i_${Date.now().toString(16)}_${randomUUID().slice(0, 12)}`
}

/** Deterministic hash of an arbitrary JSON-serializable value. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** Random permutation (Fisher-Yates). `random` is injectable for tests. */
export function shuffled<T>(input: readonly T[], random: () => number = Math.random): T[] {
  const out = [...input]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Canonical key of a tool invocation: real session identity plus the
 * assistant message and tool call id. Retries of the same invocation map to
 * the same key; never dedupe by message text.
 */
export function invocationKey(sessionID: string, messageID: string, callID: string): string {
  return `${sessionID}|${messageID}|${callID}`
}

export function sha256Of(value: unknown): string {
  return sha256(JSON.stringify(value))
}
