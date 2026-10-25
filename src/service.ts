// Local service discovery and HTTP client for the endpoints the v2.1.3
// plugin SDK does not expose in-process: session instruction entries
// (GET/PUT/DELETE /api/experimental/session/:id/instructions/entries[/:key])
// and the process-wide active set (GET /api/session/active).
//
// The service URL and password come from the local service registration
// file written by `opencode serve --service`. We verify the registered pid
// is our own process before trusting it.

import { readFileSync } from "node:fs"

export interface ServiceInfo {
  readonly id?: string
  readonly version?: string
  readonly url: string
  readonly pid: number
  readonly password?: string
}

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "ServiceError"
  }
}

export function readServiceInfo(path: string): ServiceInfo | undefined {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.url !== "string" || typeof parsed.pid !== "number") return undefined
    return {
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      url: parsed.url,
      pid: parsed.pid,
      password: typeof parsed.password === "string" ? parsed.password : undefined,
    }
  } catch {
    return undefined
  }
}

interface RequestResult<T> {
  readonly ok: T
}

export class ServiceClient {
  constructor(
    private readonly info: ServiceInfo,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Rejects unless the registered process is the current one. */
  assertSameProcess(): void {
    if (this.info.pid !== process.pid)
      throw new ServiceError(
        `service registration pid ${this.info.pid} does not match current process ${process.pid}`,
      )
  }

  private auth(): string | undefined {
    if (!this.info.password) return undefined
    const token = Buffer.from(`opencode:${this.info.password}`).toString("base64")
    return `Basic ${token}`
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
  ): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetchImpl(new URL(path, this.info.url), {
        method,
        signal: controller.signal,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.auth() ? { authorization: this.auth()! } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      let json: unknown = undefined
      try {
        const text = await response.text()
        json = text.length > 0 ? JSON.parse(text) : undefined
      } catch {
        json = undefined
      }
      if (!response.ok) {
        const message =
          json && typeof json === "object" && "message" in json && typeof (json as { message: unknown }).message === "string"
            ? (json as { message: string }).message
            : `${method} ${path} -> ${response.status}`
        throw new ServiceError(message, response.status)
      }
      return { status: response.status, json }
    } catch (error) {
      if (error instanceof ServiceError) throw error
      if (error instanceof Error && error.name === "AbortError")
        throw new ServiceError(`request to ${path} timed out after ${timeoutMs}ms`)
      throw new ServiceError(`request to ${path} failed: ${String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  async instructionsList(sessionID: string): Promise<readonly { key: string; value: unknown }[]> {
    const { json } = await this.request(
      "GET",
      `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries`,
    )
    const data = (json as { data?: unknown })?.data
    if (!Array.isArray(data)) throw new ServiceError(`unexpected instructions list response for ${sessionID}`)
    return data as readonly { key: string; value: unknown }[]
  }

  async instructionsPut(sessionID: string, key: string, value: unknown): Promise<void> {
    await this.request(
      "PUT",
      `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${encodeURIComponent(key)}`,
      { value },
    )
  }

  async instructionsRemove(sessionID: string, key: string): Promise<void> {
    await this.request(
      "DELETE",
      `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${encodeURIComponent(key)}`,
    )
  }

  /** One session by id. Throws ServiceError with status 404 when missing. */
  async sessionGet(
    sessionID: string,
  ): Promise<{
    id: string
    parentID?: string
    projectID: string
    location: { directory: string }
    time: { created: string; updated: string; archived?: string }
  }> {
    const { json } = await this.request("GET", `/api/session/${encodeURIComponent(sessionID)}`)
    const data = (json as { data?: unknown })?.data
    if (typeof data !== "object" || data === null) throw new ServiceError(`unexpected session get response for ${sessionID}`)
    return data as {
      id: string
      parentID?: string
      projectID: string
      location: { directory: string }
      time: { created: string; updated: string; archived?: string }
    }
  }

  /** All sessions of the process, paginated (the endpoint has no location filter). */
  async listSessions(pageSize = 200): Promise<
    readonly {
      id: string
      parentID?: string
      projectID: string
      location: { directory: string }
      time: { created: string; updated: string; archived?: string }
    }[]
  > {
    const out: {
      id: string
      parentID?: string
      projectID: string
      location: { directory: string }
      time: { created: string; updated: string; archived?: string }
    }[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 1000; guard++) {
      const query = `limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      const { json } = await this.request("GET", `/api/session?${query}`)
      const payload = json as { data?: unknown; cursor?: { next?: string } }
      if (!Array.isArray(payload.data)) throw new ServiceError("unexpected session list response")
      out.push(...(payload.data as typeof out))
      cursor = payload.cursor?.next
      if (!cursor) break
    }
    return out
  }

  /** Process-wide set of sessions currently running a foreground drain. */
  async sessionActive(): Promise<Set<string>> {
    const { json } = await this.request("GET", "/api/session/active")
    const data = (json as { data?: unknown })?.data
    if (typeof data !== "object" || data === null) throw new ServiceError("unexpected session.active response")
    return new Set(Object.keys(data as Record<string, unknown>))
  }
}
