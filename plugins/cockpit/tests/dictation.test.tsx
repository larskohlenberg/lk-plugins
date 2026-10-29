import { expect, test } from 'claude-code/testing'

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
// Stands for $.store, which nothing beneath the plugin answers in a test.
function store(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const values = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: values.get(e.key) }))
  on('store.set', (_, e) => {
    values.set(e.key, e.value)
    return { value: undefined }
  })
}

const DUMP = 'also ähm ich bräuchte halt bis freitag nee warte bis donnerstag die äh die zahlen für q3'
const PASTE = '<pasted_content id="1">\nfoo()\n</pasted_content id="1">'

test('a long dictation reaches Claude rewritten', async ($, on) => {
  let asked = ''
  on('model.complete', (_, e) => {
    asked = String(e.prompt)
    return { value: { isAnswered: true, text: 'Ich brauche bis Donnerstag die Zahlen für Q3.', usage } }
  })
  on('clock.now', () => ({ value: 0 }))
  store(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))

  const r = await $.prompt.submit({ text: DUMP, origin: { kind: 'composer' }, wait: false })

  expect(asked).toContain('bis freitag')
  expect(r.text).toBe('Ich brauche bis Donnerstag die Zahlen für Q3.')
})

test('pasted material stays untouched', async ($, on) => {
  let asked = ''
  on('model.complete', (_, e) => {
    asked = String(e.prompt)
    return { value: { isAnswered: true, text: 'Schau dir den Code an: [[PASTE_1]]', usage } }
  })
  on('clock.now', () => ({ value: 0 }))
  store(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))

  const r = await $.prompt.submit({ text: `${DUMP} ${PASTE}`, origin: { kind: 'composer' }, wait: false })

  expect(asked).not.toContain('foo()')
  expect(r.text).toBe(`Schau dir den Code an: ${PASTE}`)
})

test('a short prompt and a failed rewrite pass as typed', async ($, on) => {
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage } }))
  on('clock.now', () => ({ value: 0 }))
  store(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))

  expect((await $.prompt.submit({ text: 'ja, mach weiter', origin: { kind: 'composer' }, wait: false })).text).toBe('ja, mach weiter')
  expect((await $.prompt.submit({ text: DUMP, origin: { kind: 'composer' }, wait: false })).text).toBe(DUMP)
})

test('a lost placeholder sends the original', async ($, on) => {
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Schau dir den Code an.', usage } }))
  on('clock.now', () => ({ value: 0 }))
  store(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))

  const text = `${DUMP} ${PASTE}`
  expect((await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })).text).toBe(text)
})

test('a dictation that arrives as a paste block is rewritten', async ($, on) => {
  let asked = ''
  on('model.complete', (_, e) => {
    asked = String(e.prompt)
    return { value: { isAnswered: true, text: 'Ich brauche bis Donnerstag die Zahlen für Q3.', usage } }
  })
  on('clock.now', () => ({ value: 0 }))
  store(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))

  const text = `<pasted_content id="7">\n${DUMP}\n</pasted_content id="7">`
  const r = await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })

  expect(asked).toContain('bis freitag')
  expect(r.text).toBe('Ich brauche bis Donnerstag die Zahlen für Q3.')
})

test('a pasted code block alone passes as typed', async ($, on) => {
  let called = false
  on('model.complete', () => {
    called = true
    return { value: { isAnswered: true, text: 'x', usage } }
  })
  on('clock.now', () => ({ value: 0 }))
  store(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))

  const code = '<pasted_content id="2">\nconst a = { b: f(1), c: [2, 3] }; if (a.b) { run(a.c) }\n</pasted_content id="2">'
  const r = await $.prompt.submit({ text: code, origin: { kind: 'composer' }, wait: false })

  expect(called).toBe(false)
  expect(r.text).toBe(code)
})

test('the switch turns the rewrite off and on again', async ($, on) => {
  let calls = 0
  on('model.complete', () => {
    calls++
    return { value: { isAnswered: true, text: 'Ich brauche bis Donnerstag die Zahlen für Q3.', usage } }
  })
  on('clock.now', () => ({ value: 0 }))
  store(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const submit = () => $.prompt.submit({ text: DUMP, origin: { kind: 'composer' }, wait: false })

  expect((await $.command.run({ command: 'dictation-cleanup', args: 'off' })).text).toContain('off')
  expect((await submit()).text).toBe(DUMP)
  expect(calls).toBe(0)

  expect((await $.command.run({ command: 'dictation-cleanup', args: 'status' })).text).toContain('off')
  expect((await $.command.run({ command: 'dictation-cleanup' })).text).toContain('on')
  expect((await submit()).text).toBe('Ich brauche bis Donnerstag die Zahlen für Q3.')
  expect(calls).toBe(1)
})

test('the 🎙 button in the cockpit band shows the state and flips it', async ($, on) => {
  store(on)
  on('clock.now', () => ({ value: 0 }))
  // Nothing else draws beneath cockpit here.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'cockpit',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 } },
    })
    const label = async () => (await ui.find({ key: 'dictation' }))?.text
    expect(await label()).toBe('🎙')
    await ui.press({ key: 'dictation' })
    expect(await label()).toBe('🔇')
    expect((await $.command.run({ command: 'dictation-cleanup', args: 'status' })).text).toContain('off')
    await ui.press({ key: 'dictation' })
    expect(await label()).toBe('🎙')
    await ui.unmount()
  }
})
