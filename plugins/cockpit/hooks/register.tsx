import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Meter, PendingHandoff } from '../types'

// The session's prompt cache lives 1 hour after the last request.
const CACHE_TTL_MS = 60 * 60 * 1000
const WARN_BEFORE_MS = 5 * 60 * 1000
// Price of a token relative to an uncached input token (1h cache writes cost 2x).
const WEIGHT = { input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 }

const meter = atom({ plugin: 'cockpit', key: 'meter' } as const, null)
const tick = atom({ plugin: 'cockpit', key: 'tick' } as const, 0)
const handoffPath = atom({ plugin: 'cockpit', key: 'handoffPath' } as const, null)
const pendingHandoff = atom({ plugin: 'cockpit', key: 'pendingHandoff' } as const, null)

// Handoffs written inside a project land here (see ~/.claude/skills/handoff/SKILL.md).
const HANDOFF_DIR = '.claude/handoffs'
const HANDOFF_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const CONSUMED_KEY = 'consumedHandoffs'
// Only handoffs this plugin saw being written are ever offered: a file that
// arrived with a cloned repo is never turned into a prompt.
const KNOWN_KEY = 'knownHandoffs'

const HANDOFF_PROMPT =
  'Bitte führe den handoff-Skill aus. Nenne am Ende in einer eigenen Zeile den Pfad der Datei als `HANDOFF: <absoluter Pfad>`.'
// The path runs to the end of its line: project folders may contain spaces.
const HANDOFF_LINE = /^HANDOFF:\s*`?(.+?)`?\s*$/m
// A handoff path as the skill writes it: absolute, one line, a Markdown file.
const isHandoffPath = (path: string) =>
  path.length < 500 && /^(\/|[A-Za-z]:[\\/])/.test(path) && /handoff[^\\/]*\.md$/i.test(path)
const WRAP_UP_PROMPT =
  'Sind wir fertig? Prüfe, ob in dieser Session noch etwas offen ist oder dir etwas auffällt. Wenn nichts offen ist, archiviere diese Session. Sonst nenne, was offen ist, und archiviere nicht.'
const continuePrompt = (path: string) =>
  `Lies die Handoff-Datei ${path} und setze die Arbeit dort fort.`

const formatMinutes = (ms: number) => `${Math.max(0, Math.ceil(ms / 60000))}m`
const formatTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)
const formatUsd = (usd: number) => `$${usd.toFixed(2)}`
const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'week' }
const pad = (n: number) => String(n).padStart(2, '0')
const formatWhen = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const isProjectDir = (cwd: string) => !/[\\/]scratch-workspaces[\\/]/.test(cwd)

async function consumedHandoffs($: Engine): Promise<string[]> {
  const list = await $.store.get(CONSUMED_KEY)
  return Array.isArray(list) ? (list as string[]) : []
}

async function storedList($: Engine, key: string): Promise<string[]> {
  const list = await $.store.get(key)
  return Array.isArray(list) ? (list as string[]) : []
}

async function rememberHandoff($: Engine, path: string) {
  const list = await storedList($, KNOWN_KEY)
  await $.store.set(KNOWN_KEY, [...list.filter(p => p !== path), path].slice(-200))
}

async function markConsumed($: Engine, path: string) {
  const list = await consumedHandoffs($)
  await $.store.set(CONSUMED_KEY, [...list.filter(p => p !== path), path].slice(-200))
  await update($, pendingHandoff, h => (h?.path === path ? null : h))
}

async function findPendingHandoff($: Engine): Promise<PendingHandoff | null> {
  const cwd = await $.session.cwd()
  const dir = `${cwd}/${HANDOFF_DIR}`
  if (!isProjectDir(cwd) || !(await $.fs.exists(dir))) return null
  const consumed = await consumedHandoffs($)
  const known = await storedList($, KNOWN_KEY)
  const now = await $.clock.now()
  const newest = (await $.fs.list(dir))
    .filter(f => f.kind === 'file' && f.name.endsWith('.md'))
    .map(f => ({ path: `${dir}/${f.name}`, mtimeMs: f.mtimeMs }))
    .filter(f => now - f.mtimeMs < HANDOFF_MAX_AGE_MS && known.includes(f.path) && !consumed.includes(f.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  return newest ?? null
}

export const register: Register = on => {
  let weightedTokens = 0
  let lastCostUsd = 0
  let warnedFor = 0
  // The HANDOFF line is read only from the answer to our own handoff prompt.
  let isAwaitingHandoff = false

  on('session.start', async ($, e, next) => {
    const found = await findPendingHandoff($)
    await update($, pendingHandoff, () => found)
    $.clock.every(30_000, async () => {
      const m = await read($, meter)
      if (m === null) return
      const left = m.lastActivity + CACHE_TTL_MS - (await $.clock.now())
      if (left > 0 && left <= WARN_BEFORE_MS && warnedFor !== m.lastActivity) {
        warnedFor = m.lastActivity
        $.ui.toast(`Cache läuft in ${formatMinutes(left)} ab – jetzt weiterarbeiten oder Handoff`, {
          timeoutMs: 15_000,
        })
      }
      await update($, tick, n => n + 1)
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u) {
      weightedTokens +=
        u.input_tokens * WEIGHT.input +
        u.cache_creation_input_tokens * WEIGHT.cacheWrite +
        u.cache_read_input_tokens * WEIGHT.cacheRead +
        u.output_tokens * WEIGHT.output
    }
    const result = await next(e)

    if (e.agentId === undefined && !e.isAborted) {
      const now = await $.clock.now()
      await update($, meter, m => (m === null ? m : { ...m, lastActivity: now }))
      if (isAwaitingHandoff) {
        isAwaitingHandoff = false
        const path = HANDOFF_LINE.exec(e.answer)?.[1]
        if (path && isHandoffPath(path) && (await $.fs.exists(path))) {
          await update($, handoffPath, () => path)
          await rememberHandoff($, path)
        }
      }
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const costUsd = e.cost?.usd ?? 0
    const spent = costUsd - lastCostUsd
    let rate = 0
    if (spent > 0 && weightedTokens > 0) rate = spent / weightedTokens
    if (spent > 0) {
      lastCostUsd = costUsd
      weightedTokens = 0
    }
    await update($, meter, m => ({
      lastActivity: m?.lastActivity ?? now,
      contextTokens: e.context.tokens ?? m?.contextTokens ?? 0,
      limits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed })),
      costUsd,
      usdPerInputToken: rate > 0 ? rate : m?.usdPerInputToken ?? 0,
    }))

    return next(e)
  })


  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const m: Meter | null = await read($, meter)
    await read($, tick)
    const path = await read($, handoffPath)
    const pending = await read($, pendingHandoff)
    if (m === null && pending === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()

    let cacheRow = null
    if (m !== null) {
      const left = m.lastActivity + CACHE_TTL_MS - now
      const isWarm = left > 0
      const cacheColor = !isWarm ? 'red' : left <= WARN_BEFORE_MS ? 'yellow' : 'green'
      const rewrite = m.usdPerInputToken * WEIGHT.cacheWrite * m.contextTokens
      const limits = m.limits
        .map(l => `${LIMIT_LABEL[l.kind] ?? l.kind} ${Math.round(l.percentUsed)}%`)
        .join(' · ')
      cacheRow = (
        <Box justifyContent="space-between">
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              <Text color={cacheColor}>● {isWarm ? `cache warm ${formatMinutes(left)}` : 'cache kalt'}</Text>
              <Text dimColor>
                {' '}| ctx {formatTokens(m.contextTokens)}
                {rewrite > 0 ? ` | rewrite ≈ ${formatUsd(rewrite)}` : ''}
                {limits ? ` | ${limits}` : ''} | session {formatUsd(m.costUsd)}
              </Text>
            </Text>
          </Box>
          <Box flexShrink={0} gap={1} marginLeft={2}>
          <Button
            key="handoff"
            label="handoff"
            hotkey="h"
            onPress={() => {
              isAwaitingHandoff = true
              return $.prompt.submit({ text: HANDOFF_PROMPT, asUser: true })
            }}
          />
          <Button
            key="wrap-up"
            label="fertig"
            hotkey="f"
            onPress={() => $.prompt.submit({ text: WRAP_UP_PROMPT, asUser: true })}
          />
          {path !== null && (
            <Button key="clear-continue" label="clear & continue" hotkey="c" onPress={() => clearAndContinue(path)} />
          )}
          </Box>
        </Box>
      )
    }

    const clearAndContinue = async (file: string) => {
      await $.command.run({ command: 'clear' })
      await update($, handoffPath, () => null)
      await update($, meter, () => null)
      await $.prompt.submit({ text: continuePrompt(file), asUser: true })
    }

    const resume = async (file: string) => {
      await markConsumed($, file)
      await $.prompt.submit({ text: continuePrompt(file), asUser: true })
    }

    return (
      <Box flexDirection="column">
        {pending !== null && (
          <Box justifyContent="space-between">
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-middle">
                <Text color="cyan">↻ Handoff vom {formatWhen(pending.mtimeMs)}</Text>
                <Text dimColor> {pending.path.split('/').pop()}</Text>
              </Text>
            </Box>
            <Box flexShrink={0} gap={1} marginLeft={2}>
              <Button key="resume" label="weitermachen" hotkey="w" onPress={() => resume(pending.path)} />
              <Button key="ignore" label="ignorieren" hotkey="x" onPress={() => markConsumed($, pending.path)} />
            </Box>
          </Box>
        )}
        {cacheRow}
      </Box>
    )
  })
}
