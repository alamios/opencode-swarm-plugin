// Scope resolution. A scope is (server identity, project, checkout). The
// server identity is the canonical path of the local service registration
// file: the registration `id` field is a fresh UUID on every server start, so
// it cannot anchor a stable scope, while the registration path survives
// restarts and still separates distinct registrations (channels) on the same
// machine. Resolved from the session's own location, never from a ctx.location
// captured at plugin load. Subdirectories of one checkout share the checkout
// root; a different worktree (or a different repo entirely) is a different
// scope. No text-prefix matching is ever done on paths.

import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"

/**
 * Canonicalize a directory path the way the server does for its own records:
 * absolute, symlinks resolved, trailing separators removed.
 */
export function canonicalDirectory(input: string, base = process.cwd()): string {
  const abs = isAbsolute(input) ? input : resolve(base, input)
  let canonical = abs
  try {
    canonical = realpathSync(abs)
  } catch {
    // Path may not exist yet (fresh worktree); the absolute form still
    // identifies it uniquely enough for keying.
  }
  return canonical.replace(/\/+$/, "") || "/"
}

/**
 * Resolve the checkout root of a directory: canonicalize it, then walk up
 * (bounded by the filesystem root) to the nearest ancestor containing a
 * `.git` entry. `.git` may be a directory (normal clone) or a file (linked
 * worktree / submodule); either marks a checkout root. If no `.git` exists
 * anywhere up the tree, the canonicalized directory itself is the scope
 * root: non-VCS sessions share scope only by the same reported directory.
 */
export function canonicalCheckoutDirectory(input: string, base = process.cwd()): string {
  const start = canonicalDirectory(input, base)
  let dir = start
  for (;;) {
    if (existsSync(`${dir}/.git`)) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/**
 * Stable service discriminator for scope keys: the canonical path of the
 * local service registration file. The registration `id` field is a fresh
 * random UUID on every server start, so it cannot anchor a stable scope; the
 * registration path survives restarts and still separates distinct service
 * registrations (channels) on the same machine.
 */
export function canonicalServiceRef(path: string): string {
  let canonical = path
  try {
    canonical = realpathSync(resolve(path))
  } catch {
    // Missing or broken path: the resolved form still identifies it.
  }
  return canonical.replace(/\/+$/, "") || "/"
}

export interface ScopeInput {
  /** Stable service reference: canonical path of the local service registration file. */
  readonly serviceID: string
  /** Project id reported on the session. */
  readonly projectID: string
  /** Session location directory as reported by OpenCode. */
  readonly directory: string
}

/** Compute the stable scope key for a session. */
export function scopeKey(input: ScopeInput): string {
  return [input.serviceID, input.projectID, canonicalCheckoutDirectory(input.directory)].join("\u0000")
}

/**
 * Scope key for the plugin instance's own location, used as a quick filter
 * before full session-based resolution.
 */
export function locationScopeKey(serviceID: string, projectID: string, directory: string): string {
  return scopeKey({ serviceID, projectID, directory })
}
