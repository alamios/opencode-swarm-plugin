// TUI entrypoint (sibling of server.ts): shows this session's swarm identity
// and the currently available peers in the right sidebar (sidebar.content).
//
// Nodes are created imperatively, without the host's JSX runtime: OpenTUI
// brands renderables with Symbol.for("@opentui/core/Renderable"), so nodes
// built from this plugin's own @opentui/core (pinned to the host version) are
// accepted by the host's reconciler. The host RenderContext is reached via
// context.renderer.root.ctx.
//
// The TUI loads this plugin from the server inventory and does not carry the
// config entry options, so the panel resolves its own state/config paths:
// context.options first, then the plugin entry pointing at this directory in
// the server config documents (client.config.get), then the server default.
//
// The TUI has no other swarm data source, so the plugin state database is
// polled read-only and the text nodes are updated in place when values change.

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BoxRenderable, StyledText, TextRenderable, bold } from "@opentui/core"
import type { RenderContext, RGBA } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"
import { makeSql } from "./src/db"
import type { Row, Sql } from "./src/db"

const POLL_MS = 5_000
const NONE = "—"
// Same default as server.ts: join(homedir(), ".local", "state", "opencode-swarm")
const DEFAULT_STATE_DIRECTORY = join(homedir(), ".local", "state", "opencode-swarm")
// Fixed label width so "Name:" and "Peers:" values line up in the row.
const LABEL_WIDTH = 7

// Styling mirrors the host builtins: the "Swarm" header is bold with the
// theme's base color, and each line is a row of two text nodes — a bold label
// in the muted color and a value in the default color — with colors coming
// from the renderable `fg` property fed with the theme's own RGBA instances
// (ResolvedTheme colors are RGBA objects, not strings). No per-chunk colors
// are used: a chunk without `fg` inherits the node color.
interface Panel {
  readonly sessionID: string
  readonly identityValue: TextRenderable
  readonly peersValue: TextRenderable
  readonly identityRow: BoxRenderable
  readonly peersRow: BoxRenderable
  box: BoxRenderable | undefined
  identityText: string
  peersText: string
}

// ResolvedTheme colors are RGBA instances (host's @opentui/core) carrying a
// Uint16Array `buffer`; some builds may expose plain strings. The `fg` setter
// accepts both (it clones `.buffer` structurally).
function themeColor(value: unknown): RGBA | string | undefined {
  if (typeof value === "string" && value.length > 0) return value
  if (value && typeof value === "object" && "buffer" in value) return value as RGBA
  return undefined
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

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && isAbsolute(value) ? value : undefined
}

async function resolvePaths(
  context: Plugin.Context,
): Promise<{ configPath?: string; stateDirectory: string }> {
  const options = context.options as Record<string, unknown>
  const configPath = pickString(options.configPath)
  const stateDirectory = pickString(options.stateDirectory)
  if (configPath || stateDirectory) return { configPath, stateDirectory: stateDirectory ?? DEFAULT_STATE_DIRECTORY }
  // The TUI plugin instance carries no options: the plugin is admitted through
  // the server inventory. Recover the options from the config documents the
  // server reports, matching the entry that points at this plugin directory.
  try {
    const documents = await context.client.config.get(context.location ? { location: context.location } : undefined)
    const here = dirname(fileURLToPath(import.meta.url))
    for (const document of documents) {
      if (document.type !== "document") continue
      for (const entry of document.info?.plugins ?? []) {
        if (typeof entry === "string") continue
        if (entry.package !== here && resolve(entry.package) !== here) continue
        const opts = (entry.options ?? {}) as Record<string, unknown>
        return {
          configPath: pickString(opts.configPath),
          stateDirectory: pickString(opts.stateDirectory) ?? DEFAULT_STATE_DIRECTORY,
        }
      }
    }
  } catch {
    // unreachable server or unexpected response shape: fall back to defaults
  }
  return { stateDirectory: DEFAULT_STATE_DIRECTORY }
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
  async setup(context: Plugin.Context) {
    const renderer = context.renderer as unknown as { root?: { ctx?: RenderContext } }
    const renderContext = renderer.root?.ctx
    if (!renderContext) return

    const { configPath, stateDirectory } = await resolvePaths(context)
    const dbPath = join(stateDirectory, "swarm.db")
    const idleGraceMs = loadIdleGraceMs(configPath)

    const theme = context.theme as unknown as { text?: { base?: unknown; muted?: unknown } }
    const base = themeColor(theme.text?.base)
    const muted = themeColor(theme.text?.muted)

    const panels = new Map<string, Panel>()
    let db: Sql | undefined

    const refresh = async () => {
      for (const panel of [...panels.values()]) {
        if (panel.identityValue.isDestroyed) {
          panels.delete(panel.sessionID)
          continue
        }
        const current = await snapshot(dbPath, panel.sessionID, idleGraceMs)
        if (current.identity !== panel.identityText) {
          panel.identityText = current.identity
          panel.identityValue.content = current.identity
        }
        if (current.peers !== panel.peersText) {
          panel.peersText = current.peers
          panel.peersValue.content = current.peers
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

    const makeRow = (sessionID: string, key: string, label: string) => {
      const row = new BoxRenderable(renderContext, {
        id: `swarm-${key}-${sessionID}`,
        flexDirection: "row",
        gap: 1,
      })
      const labelNode = new TextRenderable(renderContext, {
        id: `swarm-${key}-label-${sessionID}`,
        content: new StyledText([bold(label)]),
        width: LABEL_WIDTH,
      })
      if (muted) labelNode.fg = muted
      const valueNode = new TextRenderable(renderContext, {
        id: `swarm-${key}-value-${sessionID}`,
        content: NONE,
      })
      row.add(labelNode)
      row.add(valueNode)
      return { row, valueNode }
    }

    const register = (sessionID: string): Panel => {
      const existing = panels.get(sessionID)
      if (existing && !existing.identityValue.isDestroyed) return existing
      const identity = makeRow(sessionID, "identity", "Name:")
      const peers = makeRow(sessionID, "peers", "Peers:")
      const panel: Panel = {
        sessionID,
        identityValue: identity.valueNode,
        peersValue: peers.valueNode,
        identityRow: identity.row,
        peersRow: peers.row,
        box: undefined,
        identityText: NONE,
        peersText: NONE,
      }
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
        box.add(panel.identityRow)
        box.add(panel.peersRow)
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
          if (!panel.identityRow.isDestroyed) panel.identityRow.destroy()
          if (!panel.peersRow.isDestroyed) panel.peersRow.destroy()
        } catch {
          // already destroyed by the host
        }
      }
      panels.clear()
      db?.close()
    }
  },
})
