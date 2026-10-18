export type Meter = {
  lastActivity: number
  contextTokens: number
  limits: { kind: string; percentUsed: number }[]
  costUsd: number
  usdPerInputToken: number
}

export type PendingHandoff = { path: string; mtimeMs: number }

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      meter: Meter | null
      tick: number
      handoffPath: string | null
      pendingHandoff: PendingHandoff | null
    }
  }
}
