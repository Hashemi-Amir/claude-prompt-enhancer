import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { command, keysOf, NAME, pane, SESSION, textOf, typed, worldOf } from './fixtures'

const ROUGH = 'add dark mode to the settings page'
const ONE_QUESTION = JSON.stringify({ questions: [{ question: 'What should dark mode cover?', options: ['Only the settings page', 'The whole app'] }] })
const TWO_QUESTIONS = JSON.stringify({
  questions: [
    { question: 'What should dark mode cover?', options: ['Only the settings page', 'The whole app'] },
    { question: 'How do users switch it?', options: ['A toggle', 'Follow the system'] },
  ],
})
const NO_QUESTIONS = '{"questions":[]}'
const ENHANCED = 'Add dark mode to the whole app, with the switch on the settings page.'
const REWRITE = JSON.stringify({ prompt: ENHANCED, changes: ['Worked in your answer: the whole app'] })

async function begin($: Engine, on: On, store: Record<string, unknown> = {}) {
  const world = worldOf(on)

  mock.store(on, store)
  const clock = mock.clock(on)
  await $.session.start(SESSION)

  return { world, clock }
}

describe('from /enhance to Run', () => {
  test('the full flow sends exactly the enhanced prompt, once, as the person', async ($, on) => {
    const { world, clock } = await begin($, on)

    world.replies.push(ONE_QUESTION, REWRITE)
    const answered = await $.command.run(command(ROUGH))

    expect(answered.text).toContain('Nothing is sent until you press Run')
    expect(world.opened).toEqual([NAME])

    await clock.settle()
    let tree = await $.ui.render(pane())

    expect(textOf(tree)).toContain('What should dark mode cover?')
    expect(textOf(tree)).toContain('0 of 1 answered')

    await $.ui.press({ plugin: NAME, key: 'a-0-1' })
    await clock.settle()
    tree = await $.ui.render(pane())

    expect(textOf(tree)).toContain(ENHANCED)
    expect(textOf(tree)).toContain('Questions answered 1 of 1')
    expect(textOf(tree)).toContain('WHAT CHANGED')
    expect(world.calls[1]?.prompt).toContain('<answer question="What should dark mode cover?">The whole app</answer>')

    await $.ui.press({ plugin: NAME, key: 'run' })

    expect(world.sent).toEqual([{ text: ENHANCED, origin: 'plugin' }])
    expect(world.closed).toContain(NAME)
  })

  test('questions go to Haiku and the rewrite to Sonnet by default', async ($, on) => {
    const { world, clock } = await begin($, on)

    world.replies.push(NO_QUESTIONS, REWRITE)
    await $.command.run(command(ROUGH))
    await clock.settle()

    expect(world.calls.map(c => c.model)).toEqual(['haiku', 'sonnet'])
  })

  test('the two models follow their settings', { options: { questionsModel: 'sonnet', rewriteModel: 'haiku' } }, async ($, on) => {
    const { world, clock } = await begin($, on)

    world.replies.push(NO_QUESTIONS, REWRITE)
    await $.command.run(command(ROUGH))
    await clock.settle()

    expect(world.calls.map(c => c.model)).toEqual(['sonnet', 'haiku'])
  })

  test('with no questions worth asking it goes straight to the rewrite', async ($, on) => {
    const { world, clock } = await begin($, on)

    world.replies.push(NO_QUESTIONS, JSON.stringify({ prompt: ROUGH, changes: [] }))
    await $.command.run(command(ROUGH))
    await clock.settle()

    const text = textOf(await $.ui.render(pane()))

    expect(world.calls.length).toBe(2)
    expect(world.calls[1]?.prompt).not.toContain('<answer ')
    expect(text).toContain('No questions needed')
    expect(text).toContain('Your prompt is already clear.')
  })

  test('a skipped question never reaches the rewrite', async ($, on) => {
    const { world, clock } = await begin($, on)

    world.replies.push(TWO_QUESTIONS, REWRITE)
    await $.command.run(command(ROUGH))
    await clock.settle()
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'a-0-1' })
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'skip-1' })
    await clock.settle()

    expect(world.calls[1]?.prompt).toContain('The whole app')
    expect(world.calls[1]?.prompt).not.toContain('How do users switch it?')
  })

  test('"Skip the rest" rewrites with what was answered so far', async ($, on) => {
    const { world, clock } = await begin($, on)

    world.replies.push(TWO_QUESTIONS, REWRITE)
    await $.command.run(command(ROUGH))
    await clock.settle()
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'rewrite-now' })
    await clock.settle()

    expect(world.calls[1]?.prompt).not.toContain('<answer ')
    expect(textOf(await $.ui.render(pane()))).toContain('Questions answered 0 of 2')
  })

  test('Send original sends the prompt exactly as typed', async ($, on) => {
    const { world, clock } = await begin($, on)

    world.replies.push(NO_QUESTIONS, REWRITE)
    await $.command.run(command(ROUGH))
    await clock.settle()
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'original' })

    expect(world.sent).toEqual([{ text: ROUGH, origin: 'plugin' }])
  })

  test('Edit then Enter runs the edited text', async ($, on) => {
    const { world, clock } = await begin($, on)

    world.replies.push(NO_QUESTIONS, REWRITE)
    await $.command.run(command(ROUGH))
    await clock.settle()
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'edit' })
    await $.ui.render(pane())
    await $.ui.input({ plugin: NAME, key: 'edit', text: 'Add dark mode everywhere.' })

    expect(world.sent).toEqual([{ text: 'Add dark mode everywhere.', origin: 'plugin' }])
  })
})

describe('cancel puts the prompt back', () => {
  test('Cancel closes the pane, stops the call and refills the prompt box', async ($, on) => {
    const { world, clock } = await begin($, on)

    world.replies.push(ONE_QUESTION, REWRITE)
    await $.command.run(command(ROUGH))
    await clock.settle()
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'cancel' })

    expect(world.fills).toEqual([ROUGH])
    expect(world.closed).toContain(NAME)
    expect(world.sent).toEqual([])
  })
})

describe('automatic mode', () => {
  test('on intercepts a typed prompt into the pane; off lets it through', async ($, on) => {
    const { world } = await begin($, on)

    await $.command.run(command('on'))
    expect(world.statuses.at(-1)).toBe('Prompt Enhancer: auto')

    world.replies.push(ONE_QUESTION)
    const caught = await $.prompt.submit(typed(ROUGH))

    expect(caught).toEqual({ drop: 'Opened in Prompt Enhancer.' })
    expect(world.opened).toEqual([NAME])
    expect(world.sent).toEqual([])

    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'cancel' })
    await $.command.run(command('off'))
    expect(world.statuses.at(-1)).toBeUndefined()

    await $.prompt.submit(typed(ROUGH))
    expect(world.sent).toEqual([{ text: ROUGH, origin: 'composer' }])
  })

  test('the switch is remembered across sessions', async ($, on) => {
    const { world } = await begin($, on, { auto: true })

    expect(world.statuses).toEqual(['Prompt Enhancer: auto'])
    expect(await $.prompt.submit(typed(ROUGH))).toEqual({ drop: 'Opened in Prompt Enhancer.' })
  })

  test('the prompt the mod sends never loops back into the pane', async ($, on) => {
    const { world, clock } = await begin($, on, { auto: true })

    world.replies.push(NO_QUESTIONS, REWRITE)
    await $.prompt.submit(typed(ROUGH))
    await clock.settle()
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'run' })

    expect(world.sent).toEqual([{ text: ENHANCED, origin: 'plugin' }])
    expect(world.opened).toEqual([NAME])
  })

  test('the caught prompt leaves the box once Claude Code has put it back, and the pane takes the keyboard', async ($, on) => {
    const { world, clock } = await begin($, on, { auto: true })

    world.replies.push(ONE_QUESTION)
    await $.prompt.submit(typed(ROUGH))
    world.box = ROUGH
    await clock.advance(200)

    expect(world.box).toBe('')
    expect(world.opened).toEqual([NAME, NAME])
  })

  test('something else typed in the box meanwhile is never cleared', async ($, on) => {
    const { world, clock } = await begin($, on, { auto: true })

    world.replies.push(ONE_QUESTION)
    await $.prompt.submit(typed(ROUGH))
    world.box = 'a different draft'
    await clock.advance(200)

    expect(world.box).toBe('a different draft')
  })

  test('Run takes the original out of the box if it is still there', async ($, on) => {
    const { world, clock } = await begin($, on, { auto: true })

    world.replies.push(NO_QUESTIONS, REWRITE)
    await $.prompt.submit(typed(ROUGH))
    world.box = ROUGH
    await clock.settle()
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'run' })

    expect(world.box).toBe('')
    expect(world.sent).toEqual([{ text: ENHANCED, origin: 'plugin' }])
  })

  test('a leading > sends the rest untouched', async ($, on) => {
    const { world } = await begin($, on, { auto: true })

    await $.prompt.submit(typed('> add dark mode to the settings page'))

    expect(world.sent).toEqual([{ text: ROUGH, origin: 'composer' }])
    expect(world.opened).toEqual([])
  })

  test('if the pane cannot be shown, the prompt goes back in the box', async ($, on) => {
    const { world } = await begin($, on, { auto: true })

    world.unplaced = true
    const result = await $.prompt.submit(typed(ROUGH))

    expect(result).toEqual({ drop: 'Prompt Enhancer could not open its pane here, so your prompt is back in the box.' })
    expect(world.fills).toEqual([ROUGH])
  })
})

describe('when the model fails', () => {
  test('an API error shows the calm card, and Try again recovers', async ($, on) => {
    const { world, clock } = await begin($, on)

    world.replies.push(null)
    await $.command.run(command(ROUGH))
    await clock.settle()
    const text = textOf(await $.ui.render(pane()))

    expect(text).toContain('Your prompt is safe.')
    expect(text).toContain('overloaded')
    expect(keysOf(await $.ui.render(pane()), 'Button')).toEqual(expect.arrayContaining(['retry', 'original', 'cancel']))

    world.replies.push(ONE_QUESTION)
    await $.ui.press({ plugin: NAME, key: 'retry' })
    await clock.settle()

    expect(textOf(await $.ui.render(pane()))).toContain('What should dark mode cover?')
  })

  test('an unreadable rewrite is retried once, then shows the error card', async ($, on) => {
    const { world, clock } = await begin($, on)

    world.replies.push(NO_QUESTIONS, 'Sure! Here is a better prompt.', 'Still not JSON.')
    await $.command.run(command(ROUGH))
    await clock.settle()

    expect(world.calls.length).toBe(3)
    expect(textOf(await $.ui.render(pane()))).toContain("The model's reply could not be read.")
  })
})

describe('history', () => {
  test('keeps the last 20, newest first, and reopening one shows its review', async ($, on) => {
    const old = Array.from({ length: 20 }, (_, i) => ({
      id: `old-${i}`,
      at: 1_000 + i,
      original: `old prompt number ${i}`,
      questions: [],
      answers: [],
      rewrite: { prompt: `Old prompt number ${i}.`, changes: [] },
      flags: [],
      outcome: 'sent-rewrite',
    }))
    const { world, clock } = await begin($, on, { history: old })

    world.replies.push(NO_QUESTIONS, REWRITE)
    await $.command.run(command(ROUGH))
    await clock.settle()
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'run' })

    const listed = await $.command.run(command('history'))

    expect(listed.text).toBe('Showing your last 20 enhanced prompts.')

    const keys = keysOf(await $.ui.render(pane()), 'Button').filter(k => k.startsWith('h-'))

    expect(keys.length).toBe(20)
    // The stored list is newest first, so the oldest, old-19, is the one that falls off.
    expect(keys).not.toContain('h-old-19')
    expect(keys[1]).toBe('h-old-0')

    await $.ui.press({ plugin: NAME, key: 'h-old-0' })
    expect(textOf(await $.ui.render(pane()))).toContain('Old prompt number 0.')
  })
})

describe('drawing', () => {
  test('review draws on terminal and desktop, side by side when wide and stacked when narrow', async ($, on) => {
    const { world, clock } = await begin($, on)

    world.replies.push(ONE_QUESTION, REWRITE)
    await $.command.run(command(ROUGH))
    await clock.settle()
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'a-0-1' })
    await clock.settle()

    for (const surface of ['terminal', 'desktop'] as const) {
      const wide = await $.ui.render(pane(surface, 160))
      const narrow = await $.ui.render(pane(surface, 60))

      expect(textOf(wide)).toContain('✓ Your prompt')
      expect(textOf(wide)).toContain('4 Review')
      expect(keysOf(wide, 'Button').slice(0, 5)).toEqual(['run', 'edit', 'copy', 'original', 'cancel'])
      expect(textOf(narrow)).toContain('PROMPT ENHANCER')
      expect(textOf(narrow)).toContain(ENHANCED)
    }

    expect(textOf(await $.ui.render(pane('terminal', 50)))).toContain('Step 4 of 4')
  })

  test('a reload mid-step brings the pane back and restarts the call it waited on', async ($, on) => {
    const { world, clock } = await begin($, on)

    await $.command.run(command(ROUGH))
    world.replies.push(ONE_QUESTION)
    await $.session.start(SESSION)
    await clock.settle()

    expect(world.opened.length).toBe(2)
    expect(textOf(await $.ui.render(pane()))).toContain('What should dark mode cover?')
  })
})

describe('every screen validates on each surface', () => {
  test('compose, questions, review, edit, error and history mount on terminal and desktop', async ($, on) => {
    const { world, clock } = await begin($, on)
    const screens: string[] = []

    async function mountAll(label: string) {
      for (const surface of ['terminal', 'desktop'] as const) {
        for (const width of [60, 160]) {
          const input = pane(surface, width)
          const mounted = await $.ui.mount({ plugin: NAME, surface, component: 'Pane', props: input.props, requestId: NAME, viewport: input.viewport })

          await mounted.unmount()
        }
      }

      screens.push(label)
    }

    await $.command.run(command(''))
    await mountAll('compose')
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'cancel' })

    world.replies.push(TWO_QUESTIONS, REWRITE)
    await $.command.run(command(ROUGH))
    await clock.settle()
    await mountAll('questions')
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'other-0' })
    await mountAll('questions with Other open')
    await $.ui.render(pane())
    await $.ui.input({ plugin: NAME, key: 'other-input-0', text: 'Just the header' })
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'skip-1' })
    await clock.settle()
    expect(world.calls[1]?.prompt).toContain('>Just the header</answer>')
    await mountAll('review')
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'edit' })
    await mountAll('edit')
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'cancel' })

    world.replies.push(null)
    await $.command.run(command(ROUGH))
    await clock.settle()
    await mountAll('error')
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'cancel' })

    await $.command.run(command('history'))
    await mountAll('history')

    expect(screens).toEqual(['compose', 'questions', 'questions with Other open', 'review', 'edit', 'error', 'history'])
  })
})

describe('a broken store never traps the person', () => {
  async function brokenStore($: Engine, on: On) {
    const world = worldOf(on)
    const clock = mock.clock(on)

    on('store.get', () => ({ deny: 'store file is malformed' }))
    on('store.set', () => ({ deny: 'store file is malformed' }))
    await $.session.start(SESSION)

    return { world, clock }
  }

  test('the session still starts, says so once, and /enhance off answers', async ($, on) => {
    const { world } = await brokenStore($, on)

    expect(world.commands).toEqual(['enhance'])
    expect((await $.command.run(command('off'))).text).toBe('Prompt Enhancer automatic mode is off.')
    expect((await $.command.run(command('on'))).text).toContain('automatic mode is on')
    expect(world.logs.filter(l => l.includes('could not use its saved settings')).length).toBe(1)
  })

  test('Run still sends and Cancel still closes when history cannot be saved', async ($, on) => {
    const { world, clock } = await brokenStore($, on)

    world.replies.push(NO_QUESTIONS, REWRITE)
    await $.command.run(command(ROUGH))
    await clock.settle()
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'run' })
    expect(world.sent).toEqual([{ text: ENHANCED, origin: 'plugin' }])

    world.replies.push(NO_QUESTIONS, REWRITE)
    await $.command.run(command(ROUGH))
    await clock.settle()
    await $.ui.render(pane())
    await $.ui.press({ plugin: NAME, key: 'cancel' })
    expect(world.fills.at(-1)).toBe(ROUGH)
    expect((await $.command.run(command(ROUGH))).text).toContain('Nothing is sent until you press Run')
  })

  test('/enhance cancel always clears a stuck prompt', async ($, on) => {
    const { world } = await brokenStore($, on)

    await $.command.run(command(ROUGH))
    expect((await $.command.run(command(''))).text).toContain('/enhance cancel')
    expect((await $.command.run(command('cancel'))).text).toBe('Prompt Enhancer closed. Your original prompt is back in the box.')
    expect(world.fills.at(-1)).toBe(ROUGH)
    expect((await $.command.run(command('cancel'))).text).toBe('Prompt Enhancer had nothing open.')
  })
})
