// Swarm plugin entry (OpenCode v2 promise API). Loaded per location; each
// instance coordinates its own scope over the shared SQLite store. Setup must
// stay fast: the server waits at most ~5s for plugin setup before serving
// requests for the location.

import { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { mkdirSync, statSync, watch } from "node:fs"
import { loadConfig, ConfigError, configFingerprint } from "./src/config"
import { openSqlite, migrate } from "./src/db"
import { Store } from "./src/store"
import { readServiceInfo, ServiceClient } from "./src/service"
import { Coordinator, type CallContext, type SwarmSendInput } from "./src/coordinator"
import { newInstanceID } from "./src/ids"
import { canonicalCheckoutDirectory, canonicalServiceRef, locationScopeKey } from "./src/scope"
import type { LoadedConfig } from "./src/types"

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name", "message"],
  properties: {
    name: {
      type: "string",
      pattern: "^[a-z\\u00E0-\\u00F6\\u00F8-\\u00FF][a-z\\u00E0-\\u00F6\\u00F8-\\u00FF0-9]*(?:-[1-9][0-9]*)?$",
      maxLength: 64,
      description:
        "Target teammate name (lowercase Latin letters, digits and accents such as á é í ó ú ü ñ, optional -N suffix); use the names listed in the <peers> element of the <swarm> context.",
    },
    message: {
      type: "string",
      minLength: 1,
      description: "Plain-text message body delivered to the target session.",
    },
    reply_to: {
      type: "string",
      minLength: 1,
      description: "Exact opaque ID of a message you received; quote it verbatim when answering that message.",
    },
    wait_for_reply: {
      type: "boolean",
      default: false,
      description:
        "Block until the first correlated reply arrives or the wait times out. Only set it when the next action depends on the answer.",
    },
  },
}

interface SwarmOptions {
  configPath?: string
  stateDirectory?: string
  serviceRegistration?: string
}

export default Plugin.define({
  id: "swarm",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as SwarmOptions
    const configPath = options.configPath
    if (!configPath || !isAbsolute(configPath))
      throw new Error("swarm: options.configPath must be an absolute path to swarm.json")
    const stateDirectory = options.stateDirectory ?? join(homedir(), ".local", "state", "opencode-swarm")
    if (!isAbsolute(stateDirectory)) throw new Error("swarm: options.stateDirectory must be an absolute path")
    const registrationPath = options.serviceRegistration ?? join(homedir(), ".local", "state", "opencode", "service.json")

    const info = readServiceInfo(registrationPath)
    if (!info) throw new Error(`swarm: no service registration at ${registrationPath}; run the server with "opencode serve --service"`)
    const client = new ServiceClient(info)
    client.assertSameProcess()

    let loaded: LoadedConfig
    try {
      loaded = loadConfig(configPath)
    } catch (error) {
      if (error instanceof ConfigError)
        throw new Error(`swarm: invalid configuration${error.field ? ` (${error.field})` : ""}: ${error.message}${error.path ? ` [${error.path}]` : ""}`)
      throw error
    }
    let currentFingerprint = configFingerprint(loaded.config, loaded.files)

    mkdirSync(stateDirectory, { recursive: true })
    const sql = await openSqlite(join(stateDirectory, "swarm.db"))
    migrate(sql)
    const store = new Store(sql)

    const instanceID = newInstanceID()
    // The registration `id` field is a fresh UUID on every server start, so it
    // cannot anchor a stable scope; the registration path is stable across
    // restarts and still separates distinct service registrations (channels).
    const serviceID = canonicalServiceRef(registrationPath)
    const scopeRoot = canonicalCheckoutDirectory(ctx.location.directory)
    const scopeKey = locationScopeKey(serviceID, ctx.location.project.id, ctx.location.directory)
    const log = (level: "info" | "warn" | "error", message: string) =>
      console.error(`[swarm:${level}] ${message}`)

    const current: { config: LoadedConfig } = { config: loaded }
    const coordinator = new Coordinator({
      store,
      client,
      current,
      scopeKey,
      scopeRoot,
      serviceID,
      instanceID,
      session: {
        synthetic: (input) => ctx.session.synthetic(input as never) as Promise<unknown>,
      },
      log,
    })

    // Tool registration: plain name "swarm" (single word, like the built-in tools).
    ctx.tool.transform((editor) => {
      editor.add({
        name: "swarm",
        description: current.config.files.toolDescription,
        input: INPUT_SCHEMA as never,
        options: { codemode: false },
        execute: (input: SwarmSendInput, toolCtx: { sessionID: string; messageID: string; id: string; signal: AbortSignal; progress?: (u: Record<string, unknown>) => Promise<void> }) => {
          const call: CallContext = {
            sessionID: toolCtx.sessionID,
            messageID: toolCtx.messageID,
            callID: toolCtx.id,
            signal: toolCtx.signal,
            progress: toolCtx.progress,
          }
          return coordinator.handleSend(input, call).then((result) => ({ content: JSON.stringify(result, null, 2) }))
        },
      } as never)
    })

    // Global event bus (all locations); the coordinator filters by scope.
    const eventsController = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventsController.signal })) {
          coordinator.onEvent(event as { type: string; data?: Record<string, unknown> })
        }
      } catch {
        // subscription ended with the plugin
      }
    })()

    coordinator.start()
    log("info", `swarm active: instance ${instanceID}, scope ${scopeKey.split("\u0000").pop()}, config ${configPath}`)

    // Config watcher with debounce; invalid candidates keep the current config.
    const stopWatchers = startConfigWatchers(loaded, () => currentFingerprint, (next) => {
      current.config = next
      currentFingerprint = configFingerprint(next.config, next.files)
      ctx.tool.transform((editor) => {
        for (const tool of editor.list()) {
          if (tool.name === "swarm") {
            editor.update(tool.id, (t) => {
              t.description = next.files.toolDescription
            })
          }
        }
      })
      void ctx.tool.reload().catch(() => undefined)
      log("info", "config reloaded")
    }, (level, message) => log(level, message))

    return async () => {
      eventsController.abort()
      stopWatchers()
      coordinator.stop()
      store.close()
      log("info", `swarm stopped: ${instanceID}`)
    }
  },
})

function startConfigWatchers(
  loaded: LoadedConfig,
  fingerprint: () => string,
  onChange: (next: LoadedConfig) => void,
  log: (level: "info" | "warn" | "error", message: string) => void,
): () => void {
  const base = dirname(loaded.configPath)
  const files = [
    loaded.configPath,
    resolve(base, loaded.config.namesFile),
    resolve(base, loaded.config.promptFile),
    resolve(base, loaded.config.toolDescriptionFile),
  ]
  const debounceMs = Math.max(loaded.config.reload.debounceMs, 100)
  let timer: ReturnType<typeof setTimeout> | undefined
  const attempt = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        const next = loadConfig(loaded.configPath)
        if (configFingerprint(next.config, next.files) === fingerprint()) return
        onChange(next)
      } catch (error) {
        log("warn", `config reload failed, keeping current: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, debounceMs)
  }
  const stops: Array<() => void> = []
  for (const file of files) {
    try {
      const watcher = watch(file, () => attempt())
      watcher.on("error", (error) => log("warn", `watch failed for ${file}: ${String(error)}`))
      stops.push(() => watcher.close())
    } catch (error) {
      log("warn", `cannot watch ${file}: ${String(error)}`)
    }
  }
  // Fallback for filesystems with weak watch support: mtime poll.
  const mtimes = files.map((file) => {
    try {
      return statSync(file).mtimeMs
    } catch {
      return 0
    }
  })
  const poll = setInterval(() => {
    for (let i = 0; i < files.length; i++) {
      let mtime = 0
      try {
        mtime = statSync(files[i]).mtimeMs
      } catch {
        continue
      }
      if (mtime !== mtimes[i]) {
        mtimes[i] = mtime
        attempt()
        break
      }
    }
  }, 2_000)
  stops.push(() => clearInterval(poll))
  return () => {
    clearTimeout(timer)
    for (const stop of stops) stop()
  }
}
