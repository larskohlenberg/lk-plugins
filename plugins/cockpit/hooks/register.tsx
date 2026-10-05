import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Meter, PendingHandoff } from '../types'

// The session's prompt cache lives 1 hour after the last request.
const CACHE_TTL_MS = 60 * 60 * 1000
const WARN_BEFORE_MS = 5 * 60 * 1000
// Price of a token relative to an uncached input token (1h cache writes cost 2x).
const WEIGHT = { input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 }

const meter = atom({ plugin: 'cockpit', key: 'meter' } as const, null)
const tick = atom({ plugin: 'cockpit', key: 'tick' } as const, 0)
const suggestions = atom({ plugin: 'cockpit', key: 'suggestions' } as const, [])
const isNextStepsOn = atom({ plugin: 'cockpit', key: 'isNextStepsOn' } as const, true)
const handoffPath = atom({ plugin: 'cockpit', key: 'handoffPath' } as const, null)
const pendingHandoff = atom({ plugin: 'cockpit', key: 'pendingHandoff' } as const, null)

// Handoffs written inside a project land here (see ~/.claude/skills/handoff/SKILL.md).
const HANDOFF_DIR = '.claude/handoffs'
const HANDOFF_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const CONSUMED_KEY = 'consumedHandoffs'

const HANDOFF_PROMPT =
  'Bitte führe den handoff-Skill aus. Nenne am Ende in einer eigenen Zeile den Pfad der Datei als `HANDOFF: <absoluter Pfad>`.'
// The path runs to the end of its line: project folders may contain spaces.
const HANDOFF_LINE = /^HANDOFF:\s*`?(.+?)`?\s*$/m
const continuePrompt = (path: string) =>
  `Lies die Handoff-Datei ${path} und setze die Arbeit dort fort.`

const NEXT_SYSTEM = `Du schlägst dem Nutzer eines KI-Assistenten die nächsten sinnvollen Schritte vor.
Antworte mit 2 oder 3 Zeilen, jede ein konkreter, kurzer Auftrag (max. 8 Wörter) in der Sprache des Gesprächs,
formuliert als Anweisung an den Assistenten. Keine Nummerierung, keine Erklärung. Wenn nichts Sinnvolles folgt, antworte mit NONE.`

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
  const now = await $.clock.now()
  const newest = (await $.fs.list(dir))
    .filter(f => f.kind === 'file' && f.name.endsWith('.md'))
    .map(f => ({ path: `${dir}/${f.name}`, mtimeMs: f.mtimeMs }))
    .filter(f => now - f.mtimeMs < HANDOFF_MAX_AGE_MS && !consumed.includes(f.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  return newest ?? null
}

async function suggest($: Engine, prompt: string, answer: string) {
  const r = await $.model.complete({
    model: 'haiku',
    system: NEXT_SYSTEM,
    prompt: `Letzte Anfrage des Nutzers:\n${prompt.slice(-2000)}\n\nAntwort des Assistenten:\n${answer.slice(-4000)}`,
    maxTokens: 200,
  })
  if (!r.isAnswered || r.text.trim() === 'NONE') return
  const lines = r.text
    .split('\n')
    .map((l: string) => l.replace(/^[\s\-*\d.)]+/, '').trim())
    .filter((l: string) => l !== '')
    .slice(0, 3)
  await update($, suggestions, () => lines)
}

export const register: Register = on => {
  let lastPrompt = ''
  let weightedTokens = 0
  let lastCostUsd = 0
  let warnedFor = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'nextsteps',
      description: 'Next-Steps-Vorschläge ein- oder ausschalten (on|off)',
    })
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

  on('command.run', { command: 'nextsteps' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isOn = arg === 'on' ? true : arg === 'off' ? false : !(await read($, isNextStepsOn))
    await update($, isNextStepsOn, () => isOn)
    if (!isOn) await update($, suggestions, () => [])

    return { text: `Next Steps ${isOn ? 'an' : 'aus'}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, suggestions, () => [])

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.text) lastPrompt = e.text

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
      const found = HANDOFF_LINE.exec(e.answer)
      if (found) {
        await update($, handoffPath, () => found[1])
        // Written by this session: not a handoff to offer back to it.
        await markConsumed($, found[1])
      }
      if (e.answer.trim() !== '' && (await read($, isNextStepsOn))) {
        void suggest($, lastPrompt, e.answer)
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
    const steps = await read($, suggestions)
    await read($, tick)
    const path = await read($, handoffPath)
    const pending = await read($, pendingHandoff)
    if (m === null && steps.length === 0 && pending === null) return next(e)

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
            onPress={() => $.prompt.submit({ text: HANDOFF_PROMPT, asUser: true })}
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
      await update($, suggestions, () => [])
      await update($, meter, () => null)
      await $.prompt.submit({ text: continuePrompt(file), asUser: true })
    }

    const resume = async (file: string) => {
      await markConsumed($, file)
      await $.prompt.submit({ text: continuePrompt(file), asUser: true })
    }

    const pick = async (text: string) => {
      await update($, suggestions, () => [])
      await $.prompt.submit({ text, asUser: true })
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
        {steps.length > 0 && !e.props.isWorking && (
          <Box flexDirection="column">
            <Text dimColor>next:</Text>
            {steps.map((s: string, i: number) => (
              <Button key={`step-${i}`} label={s} hotkey={String(i + 1)} onPress={() => pick(s)} />
            ))}
            <Button
              key="dismiss"
              label="dismiss"
              hotkey="0"
              role="dismiss"
              onPress={() => update($, suggestions, () => [])}
            />
          </Box>
        )}
      </Box>
    )
  })
}
