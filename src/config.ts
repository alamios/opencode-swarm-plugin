// Config loading and validation, per CONFIGURATION.md. The candidate is read
// as one complete unit (swarm.json plus every referenced file); only a fully
// valid candidate replaces the current config. Validation is implemented
// directly against the shipped swarm.schema.json (v1) plus the extra rules in
// CONFIGURATION.md (name rules, prompt variables, parameter relations).

import { readFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import type { LoadedConfig, SwarmConfig, SwarmFiles } from "./types"
import { sha256 } from "./ids"

export const NAME_PATTERN = /^[a-zà-öø-ÿ][a-zà-öø-ÿ0-9]*(?:-[1-9][0-9]*)?$/

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly field?: string,
    readonly path?: string,
  ) {
    super(message)
    this.name = "ConfigError"
  }
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
}

function intField(obj: Record<string, unknown>, key: string, min: number, max: number, where: string): number {
  const value = obj[key]
  if (!isInt(value) || value < min || value > max)
    throw new ConfigError(`${where}.${key} must be an integer between ${min} and ${max}`, key)
  return value
}

function boolField(obj: Record<string, unknown>, key: string, where: string): boolean {
  const value = obj[key]
  if (typeof value !== "boolean") throw new ConfigError(`${where}.${key} must be a boolean`, key)
  return value
}

function stringField(obj: Record<string, unknown>, key: string, where: string): string {
  const value = obj[key]
  if (typeof value !== "string" || value.length === 0) throw new ConfigError(`${where}.${key} must be a non-empty string`, key)
  return value
}

const OPTIONAL_KEYS = new Set(["$schema"])

function exactKeys(obj: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new ConfigError(`${where} must be an object`)
  const record = obj as Record<string, unknown>
  for (const key of Object.keys(record)) if (!keys.includes(key)) throw new ConfigError(`${where}.${key} is not allowed`, key)
  for (const key of keys) if (!OPTIONAL_KEYS.has(key) && !(key in record)) throw new ConfigError(`${where}.${key} is missing`, key)
  return record
}

export function validateConfig(json: unknown, configPath: string): SwarmConfig {
  const root = exactKeys(json, [
    "$schema",
    "version",
    "enabled",
    "namesFile",
    "promptFile",
    "toolDescriptionFile",
    "presence",
    "wait",
    "limits",
    "delivery",
    "reload",
  ], "config")
  if (root.version !== 1) throw new ConfigError("config.version must be 1", "version")
  const enabled = boolField(root, "enabled", "config")
  const namesFile = stringField(root, "namesFile", "config")
  const promptFile = stringField(root, "promptFile", "config")
  const toolDescriptionFile = stringField(root, "toolDescriptionFile", "config")

  const presence = exactKeys(root.presence, ["idleGraceMs", "reconcileEveryMs", "publishDebounceMs", "includeSubagents"], "presence")
  const wait = exactKeys(root.wait, ["timeoutMs", "cyclePolicy", "pollEveryMs"], "wait")
  const limits = exactKeys(root.limits, ["messageMaxBytes", "replyQuoteMaxChars", "sendsPerMinutePerSession", "repliesPerMinutePerSession"], "limits")
  const delivery = exactKeys(root.delivery, ["admissionTimeoutMs", "retryBaseMs", "retryMaxMs", "retryWindowMs"], "delivery")
  const reload = exactKeys(root.reload, ["enabled", "debounceMs"], "reload")

  const config: SwarmConfig = {
    version: 1,
    enabled,
    namesFile,
    promptFile,
    toolDescriptionFile,
    presence: {
      idleGraceMs: intField(presence, "idleGraceMs", 0, 604_800_000, "presence"),
      reconcileEveryMs: intField(presence, "reconcileEveryMs", 1_000, 60_000, "presence"),
      publishDebounceMs: intField(presence, "publishDebounceMs", 0, 10_000, "presence"),
      includeSubagents: boolField(presence, "includeSubagents", "presence"),
    },
    wait: {
      timeoutMs: intField(wait, "timeoutMs", 1_000, 86_400_000, "wait"),
      cyclePolicy: "send_async",
      pollEveryMs: intField(wait, "pollEveryMs", 100, 5_000, "wait"),
    },
    limits: {
      messageMaxBytes: intField(limits, "messageMaxBytes", 256, 65_536, "limits"),
      replyQuoteMaxChars: intField(limits, "replyQuoteMaxChars", 100, 8_000, "limits"),
      sendsPerMinutePerSession: intField(limits, "sendsPerMinutePerSession", 1, 1_000, "limits"),
      repliesPerMinutePerSession: intField(limits, "repliesPerMinutePerSession", 1, 1_000, "limits"),
    },
    delivery: {
      admissionTimeoutMs: intField(delivery, "admissionTimeoutMs", 1_000, 120_000, "delivery"),
      retryBaseMs: intField(delivery, "retryBaseMs", 100, 60_000, "delivery"),
      retryMaxMs: intField(delivery, "retryMaxMs", 1_000, 120_000, "delivery"),
      retryWindowMs: intField(delivery, "retryWindowMs", 1_000, 3_600_000, "delivery"),
    },
    reload: {
      enabled: boolField(reload, "enabled", "reload"),
      debounceMs: intField(reload, "debounceMs", 100, 10_000, "reload"),
    },
  }
  if (wait.cyclePolicy !== "send_async") throw new ConfigError('wait.cyclePolicy must be "send_async"', "cyclePolicy")
  if (config.delivery.retryBaseMs > config.delivery.retryMaxMs)
    throw new ConfigError("delivery.retryBaseMs must be <= delivery.retryMaxMs", "retryBaseMs")
  if (config.delivery.retryMaxMs > config.delivery.retryWindowMs)
    throw new ConfigError("delivery.retryMaxMs must be <= delivery.retryWindowMs", "retryMaxMs")
  if (config.delivery.admissionTimeoutMs > config.delivery.retryWindowMs)
    throw new ConfigError("delivery.admissionTimeoutMs must be <= delivery.retryWindowMs", "admissionTimeoutMs")
  return config
}

export function loadNames(path: string): readonly string[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new ConfigError(`names file is not valid JSON: ${String(error)}`, undefined, path)
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new ConfigError("names file must be a non-empty array", undefined, path)
  const seen = new Set<string>()
  for (const value of raw) {
    if (typeof value !== "string") throw new ConfigError("names must be strings", undefined, path)
    if (!/^[a-zà-öø-ÿ][a-zà-öø-ÿ0-9]{1,31}$/.test(value))
      throw new ConfigError(`invalid name "${value}": 2-32 lowercase Latin letters/digits (accents and ñ allowed), starting with a letter`, undefined, path)
    if (seen.has(value)) throw new ConfigError(`duplicate name "${value}"`, undefined, path)
    seen.add(value)
  }
  return raw
}

const MAX_ENTRY_BYTES = 256 * 1024

export function validatePrompt(text: string, path: string): string {
  const variables = text.match(/\{\{\s*([^{}]*)\s*\}\}/g) ?? []
  for (const variable of variables) {
    const inner = variable.replace(/\{\{|\}\}/g, "").trim()
    if (inner !== "self_name") throw new ConfigError(`unknown template variable "{{${inner}}}", only {{self_name}} is allowed`, undefined, path)
  }
  return text
}

export function renderPrompt(template: string, selfName: string): string {
  return template.replace(/\{\{\s*self_name\s*\}\}/g, selfName)
}

export function configFingerprint(config: SwarmConfig, files: SwarmFiles): string {
  return sha256(
    JSON.stringify({
      config,
      names: files.names,
      prompt: files.prompt,
      toolDescription: files.toolDescription,
    }),
  )
}

export function loadConfig(configPath: string): LoadedConfig {
  let raw: string
  try {
    raw = readFileSync(configPath, "utf8")
  } catch (error) {
    throw new ConfigError(`cannot read swarm.json: ${String(error)}`, undefined, configPath)
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new ConfigError(`swarm.json is not valid JSON: ${String(error)}`, undefined, configPath)
  }
  const config = validateConfig(json, configPath)
  const base = isAbsolute(configPath) ? dirname(configPath) : process.cwd()
  const names = loadNames(resolve(base, config.namesFile))
  let prompt: string
  let toolDescription: string
  try {
    prompt = validatePrompt(readFileSync(resolve(base, config.promptFile), "utf8"), config.promptFile)
  } catch (error) {
    if (error instanceof ConfigError) throw error
    throw new ConfigError(`cannot read promptFile: ${String(error)}`, "promptFile")
  }
  try {
    toolDescription = readFileSync(resolve(base, config.toolDescriptionFile), "utf8").trim()
  } catch (error) {
    throw new ConfigError(`cannot read toolDescriptionFile: ${String(error)}`, "toolDescriptionFile")
  }
  if (toolDescription.length === 0) throw new ConfigError("tool description is empty", "toolDescriptionFile")
  // Entry size guard: the identity entry must fit the native 256 KiB limit.
  const sample = JSON.stringify({ self_name: "x".repeat(32), instructions: prompt })
  if (Buffer.byteLength(sample, "utf8") > MAX_ENTRY_BYTES)
    throw new ConfigError("prompt renders larger than the 256 KiB instruction entry limit", "promptFile")
  return {
    config,
    files: { names, prompt, toolDescription },
    configPath,
  }
}
