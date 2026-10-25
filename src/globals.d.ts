// Minimal ambient declarations for the Bun host runtime (the compiled OpenCode
// binary is a Bun runtime). Only what the plugin uses is declared, so the
// plugin typechecks without installing @types/bun.

declare const Bun: unknown

declare module "bun:sqlite" {
  type Params = (string | number | null)[]
  type Row = Record<string, string | number | null | undefined>
  export class Database {
    constructor(path: string, options?: { create?: boolean; readonly?: boolean })
    exec(sql: string): void
    close(): void
    query(sql: string): {
      run(...params: Params): number
      get(...params: Params): Row | undefined
      all(...params: Params): Row[]
    }
  }
}
