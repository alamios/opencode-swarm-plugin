import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, ConfigError, renderPrompt, validatePrompt } from "../src/config"
import { truncateQuote } from "../src/render"

let dir: string

before(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-cfg-"))
})
after(() => rmSync(dir, { recursive: true, force: true }))

function writeFixture(name: string, overrides: Record<string, unknown> = {}): string {
  const base = join(dir, name)
  mkdirSync(base, { recursive: true })
  const path = join(base, "swarm.json")
  writeFileSync(join(base, "names.json"), JSON.stringify(["abeja", "zorro"]))
  writeFileSync(join(base, "swarm-prompt.md"), "Eres {{self_name}}.")
  writeFileSync(join(base, "tool-description.md"), "Envía mensajes a compañeros.")
  const config = {
    version: 1,
    enabled: true,
    namesFile: "./names.json",
    promptFile: "./swarm-prompt.md",
    toolDescriptionFile: "./tool-description.md",
    presence: { idleGraceMs: 1800000, reconcileEveryMs: 5000, publishDebounceMs: 500, includeSubagents: false },
    wait: { timeoutMs: 1200000, cyclePolicy: "send_async", pollEveryMs: 250 },
    limits: { messageMaxBytes: 8192, replyQuoteMaxChars: 1200, sendsPerMinutePerSession: 30, repliesPerMinutePerSession: 60 },
    delivery: { admissionTimeoutMs: 15000, retryBaseMs: 1000, retryMaxMs: 30000, retryWindowMs: 300000 },
    reload: { enabled: true, debounceMs: 500 },
    ...overrides,
  }
  writeFileSync(path, JSON.stringify(config))
  return path
}

test("valid config loads with files resolved relative to swarm.json", () => {
  const path = writeFixture("ok")
  const loaded = loadConfig(path)
  assert.equal(loaded.config.version, 1)
  assert.deepEqual(loaded.files.names, ["abeja", "zorro"])
  assert.equal(loaded.files.prompt, "Eres {{self_name}}.")
  assert.equal(loaded.configPath, path)
})

test("missing swarm.json fails with a diagnostic", () => {
  assert.throws(() => loadConfig(join(dir, "nope", "swarm.json")), /cannot read swarm\.json/)
})

test("invalid JSON fails", () => {
  const base = join(dir, "badjson")
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, "swarm.json"), "{ nope")
  assert.throws(() => loadConfig(join(base, "swarm.json")), /not valid JSON/)
})

test("schema violations are rejected", () => {
  const path = writeFixture("version", { version: 2 })
  assert.throws(() => loadConfig(path), /version must be 1/)

  const path2 = writeFixture("cycle", { wait: { timeoutMs: 1200000, cyclePolicy: "other", pollEveryMs: 250 } })
  assert.throws(() => loadConfig(path2), /cyclePolicy/)

  const path3 = writeFixture("missing", { wait: undefined })
  assert.throws(() => loadConfig(path3), /wait/)

  const path4 = writeFixture("extra", { nope: 1 })
  assert.throws(() => loadConfig(path4), /not allowed/)
})

test("parameter relations are enforced", () => {
  const path = writeFixture("rel1", { delivery: { admissionTimeoutMs: 15000, retryBaseMs: 50000, retryMaxMs: 30000, retryWindowMs: 300000 } })
  assert.throws(() => loadConfig(path), /retryBaseMs must be <= delivery\.retryMaxMs/)

  const path2 = writeFixture("rel2", { delivery: { admissionTimeoutMs: 15000, retryBaseMs: 1000, retryMaxMs: 120000, retryWindowMs: 30000 } })
  assert.throws(() => loadConfig(path2), /retryMaxMs must be <= delivery\.retryWindowMs/)

  const path3 = writeFixture("rel3", { delivery: { admissionTimeoutMs: 120000, retryBaseMs: 1000, retryMaxMs: 30000, retryWindowMs: 30000 } })
  assert.throws(() => loadConfig(path3), /admissionTimeoutMs must be <= delivery\.retryWindowMs/)
})

test("name rules: lowercase latin with accents, 2-32, unique", () => {
  const bad = [
    JSON.stringify(["Abela"]),
    JSON.stringify(["Águila"]),
    JSON.stringify(["a"]),
    JSON.stringify(["x".repeat(33)]),
    JSON.stringify(["con espacio"]),
    JSON.stringify(["9vidas"]),
    JSON.stringify(["muro-0"]),
    JSON.stringify(["a÷b"]),
    JSON.stringify(["猫"]),
    JSON.stringify(["abeja", "abeja"]),
    JSON.stringify([]),
  ]
  bad.forEach((content, i) => {
    const base = join(dir, `names-${i}`)
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, "names.json"), content)
    writeFileSync(join(base, "swarm.json"), JSON.stringify(loadFixtureJson()))
    writeFileSync(join(base, "swarm-prompt.md"), "p")
    writeFileSync(join(base, "tool-description.md"), "d")
    assert.throws(() => loadConfig(join(base, "swarm.json")), ConfigError)
  })

  const base = join(dir, "names-accents")
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, "names.json"), JSON.stringify(["águila", "musaraña", "tucán", "cúculo"]))
  writeFileSync(join(base, "swarm.json"), JSON.stringify(loadFixtureJson()))
  writeFileSync(join(base, "swarm-prompt.md"), "p")
  writeFileSync(join(base, "tool-description.md"), "d")
  const loaded = loadConfig(join(base, "swarm.json"))
  assert.deepEqual(loaded.files.names, ["águila", "musaraña", "tucán", "cúculo"])
})

function loadFixtureJson() {
  return {
    version: 1,
    enabled: true,
    namesFile: "./names.json",
    promptFile: "./swarm-prompt.md",
    toolDescriptionFile: "./tool-description.md",
    presence: { idleGraceMs: 1, reconcileEveryMs: 5000, publishDebounceMs: 500, includeSubagents: false },
    wait: { timeoutMs: 1200000, cyclePolicy: "send_async", pollEveryMs: 250 },
    limits: { messageMaxBytes: 8192, replyQuoteMaxChars: 1200, sendsPerMinutePerSession: 30, repliesPerMinutePerSession: 60 },
    delivery: { admissionTimeoutMs: 15000, retryBaseMs: 1000, retryMaxMs: 30000, retryWindowMs: 300000 },
    reload: { enabled: true, debounceMs: 500 },
  }
}

test("only {{self_name}} is an allowed template variable", () => {
  assert.equal(renderPrompt("Eres {{self_name}}.", "garza"), "Eres garza.")
  assert.throws(() => validatePrompt("hola {{otra_var}}", "x"), /unknown template variable/)
  // Tolerates inner whitespace around the allowed variable.
  assert.equal(validatePrompt("hola {{ self_name }}", "x"), "hola {{ self_name }}")
})

test("quotes truncate by code points with an explicit marker", () => {
  const emoji = "🦋" // one code point, two UTF-16 units
  const text = emoji.repeat(5)
  const { text: kept, truncated } = truncateQuote(text, 3)
  assert.equal(truncated, true)
  // 3 kept code points + the marker " […]" (4 code points).
  assert.equal(Array.from(kept).length, 7)
  assert.ok(kept.endsWith(" […]"))
  const short = truncateQuote("hola", 10)
  assert.equal(short.truncated, false)
  assert.equal(short.text, "hola")
})
