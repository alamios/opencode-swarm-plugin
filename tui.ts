// TUI entrypoint (sibling of server.ts): shows this session's swarm identity
// and the currently available peers in the right sidebar (sidebar.content).
//
// Nodes are created imperatively, without the host's JSX runtime: OpenTUI
// brands renderables with Symbol.for("@opentui/core/Renderable"), so nodes
// built from this plugin's own @opentui/core (pinned to the host version) are
// accepted by the host's reconciler. The host RenderContext is reached via
// context.renderer.root.ctx.
//
// The TUI has no other swarm data source, so the plugin state database is
// polled read-only and the text nodes are updated in place when values change.

import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { BoxRenderable, StyledText, TextRenderable, bold } from "@opentui/core"
import type { RenderContext } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"
import { makeSql } from "./src/db"
import type { Row, Sql } from "./src/db"

const POLL_MS = 5_000
const NONE = "—"

interface Panel {
  readonly sessionID: string
  readonly identity: TextRenderable
  readonly peers: TextRenderable
  box: BoxRenderable | undefined
  identityText: string
  peersText: string
}

function themeColor(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

async function openReadOnly(path: string): Promise<Sql | undefined> {
  if (!existsSync(path)) return undefined
  try {
    if (typeof Bun !== "undefined") {
      const { Database } = await import("bun:sqlite")
      const db = new Database(path, { create: false, readonly: true })
      return makeSql({
        prepare: (sql: string) => db.query(sql),
        exec: (sql: string) => db.exec(sql),
        close: () => db.close(),
      })
    }
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(path, { readOnly: true })
    const normalize = (row: Record<string, unknown>): Row => {
      const out: Row = {}
      for (const [key, value] of Object.entries(row)) {
        out[key] = typeof value === "bigint" ? Number(value) : (value as Row[string])
      }
      return out
    }
    return makeSql({
      prepare: (sql: string) => {
        const stmt = db.prepare(sql)
        return {
          run: (...params: readonly (string | number | null)[]) => stmt.run(...params),
          get: (...params: readonly (string | number | null)[]) => {
            const row = stmt.get(...params)
            return row === undefined ? undefined : normalize(row)
          },
          all: (...params: readonly (string | number | null)[]) => stmt.all(...params).map(normalize),
        }
      },
      exec: (sql: string) => db.exec(sql),
      close: () => db.close(),
    })
  } catch {
    return undefined
  }
}

function loadIdleGraceMs(configPath: string | undefined): number {
  if (typeof configPath !== "string" || !isAbsolute(configPath)) return 0
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      presence?: { idleGraceMs?: unknown }
    }
    const value = raw?.presence?.idleGraceMs
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

function identityOf(db: Sql, sessionID: string): { name: string; scopeKey: string } | undefined {
  const row = db.get("SELECT name, scope_key, tombstone FROM identities WHERE session_id = ?", [sessionID])
  if (!row || row.tombstone) return undefined
  return { name: String(row.name), scopeKey: String(row.scope_key) }
}

function availablePeers(db: Sql, scopeKey: string, selfSession: string, now: number, idleGraceMs: number): string[] {
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

export default Plugin.define({
  id: "swarm",
  setup(context: Plugin.Context) {
    const options = context.options as Record<string, unknown>
    const stateDirectory = options.stateDirectory
    if (typeof stateDirectory !== "string" || !isAbsolute(stateDirectory)) return
    const dbPath = join(stateDirectory, "swarm.db")
    const idleGraceMs = loadIdleGraceMs(options.configPath as string | undefined)

    const renderer = context.renderer as unknown as { root?: { ctx?: RenderContext } }
    const renderContext = renderer.root?.ctx
    if (!renderContext) return

    const theme = context.theme as unknown as { text?: { base?: unknown; muted?: unknown } }
    const base = themeColor(theme.text?.base)
    const muted = themeColor(theme.text?.muted)

    const panels = new Map<string, Panel>()
    let db: Sql | undefined

    const refresh = async () => {
      for (const panel of [...panels.values()]) {
        if (panel.identity.isDestroyed) {
          panels.delete(panel.sessionID)
          continue
        }
        const current = await snapshot(dbPath, panel.sessionID, idleGraceMs)
        if (current.identity !== panel.identityText) {
          panel.identityText = current.identity
          panel.identity.content = current.identity
        }
        if (current.peers !== panel.peersText) {
          panel.peersText = current.peers
          panel.peers.content = current.peers
        }
      }
    }

    const snapshot = async (
      path: string,
      sessionID: string,
      graceMs: number,
    ): Promise<{ identity: string; peers: string }> => {
      try {
        db ??= await openReadOnly(path)
        if (!db) return { identity: NONE, peers: NONE }
        const identity = identityOf(db, sessionID)
        if (!identity) return { identity: NONE, peers: NONE }
        const peers = availablePeers(db, identity.scopeKey, sessionID, Date.now(), graceMs)
        return {
          identity: identity.name,
          peers: peers.length > 0 ? peers.join(", ") : NONE,
        }
      } catch {
        return { identity: NONE, peers: NONE }
      }
    }

    const timer = setInterval(() => {
      void refresh()
    }, POLL_MS)

    const register = (sessionID: string): Panel => {
      const existing = panels.get(sessionID)
      if (existing && !existing.identity.isDestroyed) return existing
      const identity = new TextRenderable(renderContext, { id: `swarm-identity-${sessionID}`, content: NONE })
      const peers = new TextRenderable(renderContext, { id: `swarm-peers-${sessionID}`, content: NONE })
      if (base) identity.fg = base
      if (muted) peers.fg = muted
      const panel: Panel = { sessionID, identity, peers, box: undefined, identityText: NONE, peersText: NONE }
      panels.set(sessionID, panel)
      void refresh()
      return panel
    }

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input: { readonly sessionID: string }) => {
        const panel = register(input.sessionID)
        const box = new BoxRenderable(renderContext, {
          id: `swarm-panel-${panel.sessionID}`,
          flexDirection: "column",
        })
        const header = new TextRenderable(renderContext, {
          id: `swarm-header-${panel.sessionID}`,
          content: new StyledText([bold("Swarm")]),
        })
        if (base) header.fg = base
        box.add(header)
        box.add(panel.identity)
        box.add(panel.peers)
        panel.box = box
        return box as unknown as never
      },
    })

    return () => {
      clearInterval(timer)
      unregister()
      for (const panel of panels.values()) {
        try {
          if (panel.box && !panel.box.isDestroyed) panel.box.destroy()
          if (!panel.identity.isDestroyed) panel.identity.destroy()
          if (!panel.peers.isDestroyed) panel.peers.destroy()
        } catch {
          // already destroyed by the host
        }
      }
      panels.clear()
      db?.close()
    }
  },
})
