import { expect, test } from 'claude-code/testing'

const METER = { lastActivity: 0, contextTokens: 1000, limits: [], costUsd: 0.1, usdPerInputToken: 0 }

test("another mod's band joins the cockpit buttons; the cache row has no ctx or words", async ($, on) => {
  on('state.get', (_, e) => ({
    value: { value: e.key === 'meter' ? METER : e.key === 'tick' ? 0 : null, version: 1 },
  }))
  on('clock.now', () => ({ value: 0 }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>band beneath</Text>
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'cockpit',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 } },
    })
    expect(await ui.find({ type: 'Text', text: /ctx|warm|kalt/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /● 60/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /band beneath/ }))?.text).toBe('band beneath')
    await ui.unmount()
  }
})
