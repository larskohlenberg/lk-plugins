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

// ── Dictation cleanup ─────────────────────────────────────────────

// Below this length a prompt is sent as typed ("ja", "mach weiter").
const MIN_CHARS = 40

// Terms to spell exactly so; add your own names, companies and projects here.
const VOCABULARY = [
  'Claude', 'Claude Code', 'Anthropic', 'Opus', 'Sonnet', 'Haiku',
  'OpenRouter', 'OpenWhispr', 'Orukeet', 'Parakeet', 'Whisper',
]

// Known mishearings of the speech recognition, as heard → meant.
const MISHEARINGS = [
  ['Cloud Code', 'Claude Code'], ['Antropic', 'Anthropic'], ['Entropic', 'Anthropic'],
  ['HICU', 'Haiku'], ['Haiko', 'Haiku'], ['Urukate', 'Orukeet'],
]

// Haiku 5.5 list price in $ per million tokens (OpenRouter, 2026-10-28).
const PRICE = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }

// Pasted material (code, logs, transcripts) must reach Claude untouched.
const PASTE = /<pasted_content id="[^"]*">[\s\S]*?<\/pasted_content id="[^"]*">/g
const PASTE_BODY = /^<pasted_content id="[^"]*">([\s\S]*?)<\/pasted_content id="[^"]*">$/

// Long dictation arrives as a paste block (OpenWhispr inserts via clipboard).
// A message made only of such blocks counts as spoken when the text reads as prose.
function isProse(text: string): boolean {
  const t = text.trim()
  if (t.length < MIN_CHARS || t.includes('```') || t.split('\n').length > 30) return false
  const symbols = (t.match(/[{}()\[\];<>=$#|\\_*`]/g) ?? []).length
  const letters = (t.match(/\p{L}/gu) ?? []).length
  return symbols / t.length < 0.02 && letters / t.replace(/\s/g, '').length > 0.8
}

// Notes the desktop app puts in front of a session's first prompt, as first → last
// sentence. They reach Claude untouched; only the words after them are spoken.
const APP_NOTES = [
  { start: 'The session started without a project folder', end: 'never in prose.' },
]

// Splits a leading app note off; `null` when a note's end isn't found, so the
// prompt passes as typed rather than risk rewriting the app's instructions.
function splitAppNote(text: string): { note: string; rest: string } | null {
  const lead = text.length - text.trimStart().length
  for (const { start, end } of APP_NOTES) {
    if (!text.startsWith(start, lead)) continue
    const at = text.indexOf(end, lead)
    if (at < 0) return null
    const cut = at + end.length
    return { note: text.slice(0, cut), rest: text.slice(cut) }
  }
  return { note: '', rest: text }
}

function unwrapDictation(text: string): string {
  const blocks = text.match(PASTE) ?? []
  if (blocks.length === 0 || text.replace(PASTE, '').trim()) return text
  const bodies = blocks.map(b => b.match(PASTE_BODY)?.[1] ?? '')
  return bodies.every(isProse) ? bodies.map(b => b.trim()).join('\n\n') : text
}

const SYSTEM = `You rewrite a dictated message into a clear prompt for an AI coding and work assistant. You never answer, execute or comment on the message — you only rewrite it.

The message was usually spoken: it has filler words, restarts, self-corrections, jumps between topics and sometimes contradictions.

Rewrite it so that:
- every distinct request, fact, condition, constraint, example and detail is kept — never drop or invent content
- self-corrections keep only the final version ("nee warte", "ich meine", "also eigentlich", "wait no")
- repetitions of the same thought become one statement
- related points are grouped; the main request comes first
- real contradictions that the speaker did not resolve are kept and marked as an open question, never decided by you
- spelling, grammar and punctuation are correct
- the language of the message is kept (usually German) — never translate
- the speaker's perspective (ich/du) and tone stay; it is still their message, not a formal spec
- names and terms are spelled exactly like this: ${VOCABULARY.join(', ')}
- obvious speech-recognition errors are fixed from context, e.g. ${MISHEARINGS.map(([heard, meant]) => `"${heard}" → "${meant}"`).join(', ')}

Structure: for a short or already clear message, return clean prose only. For a long or tangled one, use short paragraphs or a few bullets — no headings unless the message covers several separate topics.

Placeholders like [[PASTE_1]] stand for pasted material: keep each one exactly once, unchanged, where it belongs.

Output only the rewritten message — no preamble, no quotes, no remarks.`

// The switch survives sessions in the store (unset means on); the atom mirrors
// it for the 🎙 button in the cockpit band, which redraws when it changes.
const ENABLED = 'dictationEnabled'
const dictationOn = atom({ plugin: 'cockpit', key: 'dictationOn' } as const, true)

async function setDictationOn($: Engine, value: boolean) {
  await $.store.set(ENABLED, value)
  await update($, dictationOn, () => value)
}

// Called from cockpit's session.start: the command and the stored switch.
async function startDictation($: Engine) {
  await $.command.register({
    name: 'dictation-cleanup',
    description: 'Turn the dictation cleanup on or off (on | off | status; no argument toggles)',
  })
  const stored = (await $.store.get(ENABLED)) !== false
  await update($, dictationOn, () => stored)
}

// Dictation cleanup: rewrites dictated prompts with Haiku before Claude reads them.
function registerDictation(on: Parameters<Register>[0]) {
  on('command.run', { command: 'dictation-cleanup' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    const wasOn = (await $.store.get(ENABLED)) !== false
    if (arg === 'status') return { text: `dictation-cleanup is ${wasOn ? 'on' : 'off'}.` }
    if (arg && arg !== 'on' && arg !== 'off') {
      return { text: 'Usage: /dictation-cleanup [on | off | status]' }
    }
    const turnOn = arg ? arg === 'on' : !wasOn
    await setDictationOn($, turnOn)
    return {
      text: turnOn
        ? 'dictation-cleanup is on: dictated prompts are rewritten by Haiku.'
        : 'dictation-cleanup is off: prompts reach Claude as typed.',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const isOwn = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (e.command || e.isMeta || !isOwn) return next(e)
    if ((await $.store.get(ENABLED)) === false) return next(e)

    const split = splitAppNote(e.text)
    if (!split) return next(e)
    const pastes: string[] = []
    const spoken = unwrapDictation(split.rest).replace(PASTE, block => {
      pastes.push(block)
      return `[[PASTE_${pastes.length}]]`
    })
    if (spoken.replace(/\[\[PASTE_\d+\]\]/g, '').trim().length < MIN_CHARS) return next(e)

    $.ui.status('🎙 structuring…')
    const startedAt = await $.clock.now()
    const r = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: `<message>\n${spoken}\n</message>`,
      maxTokens: Math.min(8000, Math.max(1024, spoken.length)),
      effort: 'low',
      timeoutMs: 20000,
    })
    $.ui.status(undefined)
    const seconds = ((await $.clock.now()) - startedAt) / 1000
    const u = r.usage
    const dollars =
      (u.input_tokens * PRICE.input +
        u.output_tokens * PRICE.output +
        u.cache_read_input_tokens * PRICE.cacheRead +
        u.cache_creation_input_tokens * PRICE.cacheWrite) /
      1e6
    const stats = `${seconds.toFixed(1)} s · ${u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens} in / ${u.output_tokens} out tokens · ≈ ${(dollars * 100).toFixed(3)} ¢`

    if (!r.isAnswered) {
      $.ui.toast(`dictation-cleanup: sent as typed (${r.reason}, ${stats})`)
      return next(e)
    }

    // Haiku sometimes echoes the <message> wrapper it was given.
    let rewritten = r.text.trim().replace(/^<message>\s*([\s\S]*?)\s*<\/message>$/, '$1').trim()
    const placeholdersKept = pastes.every(
      (_, i) => rewritten.split(`[[PASTE_${i + 1}]]`).length === 2,
    )
    if (!rewritten || !placeholdersKept) {
      $.ui.toast('dictation-cleanup: sent as typed (rewrite incomplete)')
      return next(e)
    }
    // Shown with placeholders, so a long paste doesn't flood the line.
    const shown = rewritten
    pastes.forEach((block, i) => {
      rewritten = rewritten.replace(`[[PASTE_${i + 1}]]`, () => block)
    })

    // One row per paragraph: the transcript draws a log row as a single line.
    $.ui.log(`dictation-cleanup — ${stats} · ${spoken.length} → ${shown.length} chars`)
    $.ui.log('Claude reads:')
    shown
      .split(/\n+/)
      .filter(line => line.trim())
      .forEach(line => $.ui.log(`    ${line}`))
    return next({ ...e, text: split.note ? `${split.note}\n\n${rewritten}` : rewritten })
  }).catch(($, e, next) => next(e)) // a failed rewrite never blocks the prompt
}

// ── Cockpit ───────────────────────────────────────────────────────

export const register: Register = on => {
  registerDictation(on)

  let weightedTokens = 0
  let lastCostUsd = 0
  let warnedFor = 0
  // The HANDOFF line is read only from the answer to our own handoff prompt.
  let isAwaitingHandoff = false

  on('session.start', async ($, e, next) => {
    await startDictation($)
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
    const isDictationOn = await read($, dictationOn)

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    // Other mods' bands join the buttons instead of being hidden.
    const below = await next(e)
    const dictationButton = (
      <Button
        key="dictation"
        label={isDictationOn ? '🎙' : '🔇'}
        hotkey="d"
        onPress={() => setDictationOn($, !isDictationOn)}
      />
    )
    if (m === null && pending === null) {
      return (
        <Box gap={1}>
          {dictationButton}
          {below}
        </Box>
      )
    }

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
              <Text color={cacheColor}>● {isWarm ? formatMinutes(left) : ''}</Text>
              <Text dimColor>
                {rewrite > 0 ? ` | rewrite ≈ ${formatUsd(rewrite)}` : ''}
                {limits ? ` | ${limits}` : ''} | session {formatUsd(m.costUsd)}
              </Text>
            </Text>
          </Box>
          <Box flexShrink={0} gap={1} marginLeft={2}>
          {below}
          {dictationButton}
          <Button
            key="handoff"
            label="↪"
            hotkey="h"
            onPress={() => {
              isAwaitingHandoff = true
              return $.prompt.submit({ text: HANDOFF_PROMPT, asUser: true })
            }}
          />
          <Button
            key="wrap-up"
            label="✓"
            hotkey="f"
            onPress={() => $.prompt.submit({ text: WRAP_UP_PROMPT, asUser: true })}
          />
          {path !== null && (
            <Button key="clear-continue" label="⟳" hotkey="c" onPress={() => clearAndContinue(path)} />
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
              <Button key="resume" label="▶" hotkey="w" onPress={() => resume(pending.path)} />
              <Button key="ignore" label="✕" hotkey="x" onPress={() => markConsumed($, pending.path)} />
            </Box>
          </Box>
        )}
        {cacheRow ?? below}
      </Box>
    )
  })
}
