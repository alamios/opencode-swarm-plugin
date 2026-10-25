// Rendering of the recipient-visible text, the swarm context entry, and the
// durable envelope metadata. The visible text is what the peer model reads
// (synthetic messages carry only `text` to the model; metadata is not shown),
// so everything the peer needs — sender, message ID, quoted original, body —
// is in the text. Metadata keeps the machine envelope for the plugin's own records.

import type { Envelope } from "./types"

/**
 * Truncate to at most maxCodePoints Unicode code points, adding an explicit
 * marker when anything was dropped. Code points (not bytes, not UTF-16 units)
 * per CONFIGURATION.md.
 */
export function truncateQuote(text: string, maxCodePoints: number): { text: string; truncated: boolean } {
  const points = Array.from(text)
  if (points.length <= maxCodePoints) return { text, truncated: false }
  const kept = points.slice(0, maxCodePoints)
  return { text: kept.join("") + " […]", truncated: true }
}

/**
 * Recipient-visible text: a single JSON object. The fixed fields (from, to,
 * id) are never produced from peer-supplied content, so a body cannot forge
 * them; the envelope ID and sender are repeated verbatim for correlation.
 * Replies add `reply_to` and a truncated `original` quote.
 */
export function renderOutbound(envelope: Envelope, originalQuote: string | undefined, maxQuoteChars: number): string {
  const body: Record<string, unknown> = {
    from: envelope.fromName,
    to: envelope.toName,
    id: envelope.id,
  }
  if (envelope.reply) {
    body.reply_to = envelope.reply
    if (originalQuote !== undefined) body.original = truncateQuote(originalQuote, maxQuoteChars).text
  }
  body.message = envelope.message
  return JSON.stringify(body, null, 2)
}

/**
 * Value of the single `swarm` instruction entry: a plain string, so the core
 * renders it verbatim (string values bypass JSON.stringify in the core's
 * renderValue). The core still wraps it in its own `<context key="swarm">`
 * block (mechanism-neutral, unavoidable); the inner structure is the plugin's.
 */
export function renderSwarmContext(name: string, peers: string[], prompt: string): string {
  return [
    "<swarm>",
    `<identity>${name}</identity>`,
    `<peers>${peers.join(", ")}</peers>`,
    "<instructions>",
    prompt.trimEnd(),
    "</instructions>",
    "</swarm>",
  ].join("\n")
}

/** Machine envelope carried in synthetic message metadata. */
export function envelopeMetadata(envelope: Envelope): Record<string, unknown> {
  return {
    protocol: envelope.protocol,
    id: envelope.id,
    scopeKey: envelope.scopeKey,
    fromSessionID: envelope.fromSessionID,
    toSessionID: envelope.toSessionID,
    fromName: envelope.fromName,
    toName: envelope.toName,
    reply_to: envelope.reply ?? null,
    createdAt: envelope.createdAt,
  }
}
