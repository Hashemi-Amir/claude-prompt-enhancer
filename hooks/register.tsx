import type { EngineInterface, Register } from 'claude-code'

import {
  cancel,
  clearHistory,
  getAuto,
  getFlow,
  getHistory,
  openHistory,
  openPane,
  PANE,
  restore,
  schedule,
  setAuto,
  setFlow,
  startCompose,
  startFlow,
  tidyAfterDrop,
} from './flow'
import { decide } from './intercept'
import { renderPane } from './view'

const FAILED = 'Prompt Enhancer hit a problem and did nothing. Your prompt is unchanged.'

/** Opens the pane without holding up the caller, saying so in one line when it cannot be shown. */
function show($: EngineInterface): void {
  openPane($)
    .then(isPlaced => {
      if (!isPlaced) $.ui.log('Prompt Enhancer is open but has no room to draw here yet; widen the terminal to see it.')
    })
    .catch(() => undefined)
}

export const register: Register = (on, options) => {
  const model = options.model === 'sonnet' ? 'sonnet' : 'haiku'

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({
      name: 'enhance',
      description: 'Sharpen a prompt before sending it, using only your words and answers',
      argumentHint: '[prompt | on | off | history | cancel]',
    })

    const isAuto = await restore($)

    if (isAuto) {
      $.ui.status('Prompt Enhancer: auto')
    }

    // A reload mid-step: bring the pane back and restart the call it was waiting on.
    const flow = await getFlow($)

    if (flow !== null) {
      void openPane($).catch(() => undefined)

      if (flow.pending !== null) {
        schedule($, model)
      }
    }

    return started
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'enhance' }, async ($, e) => {
    const args = e.args.trim()
    const word = args.toLowerCase()
    const flow = await getFlow($)
    const isBusy = flow !== null && flow.step !== 'compose'

    if (word === 'on' || word === 'off') {
      await setAuto($, word === 'on')

      return {
        text:
          word === 'on'
            ? 'Prompt Enhancer automatic mode is on. Prompts you type open in the pane first; start one with > to send it as is.'
            : 'Prompt Enhancer automatic mode is off.',
      }
    }

    if (word === 'cancel') {
      await cancel($, { isClosed: false })

      return { text: flow === null ? 'Prompt Enhancer had nothing open.' : 'Prompt Enhancer closed. Your original prompt is back in the box.' }
    }

    if (word === 'history clear') {
      await clearHistory($)

      return { text: 'Prompt Enhancer history cleared.' }
    }

    if (word === 'history') {
      if (isBusy) {
        show($)

        return { text: 'Prompt Enhancer is working on a prompt. Finish it in the pane, or type /enhance cancel.' }
      }

      await setFlow($, () => null)
      await openHistory($)
      show($)
      const count = (await getHistory($)).length

      return { text: count === 0 ? 'No enhanced prompts yet.' : `Showing your last ${count} enhanced prompts.` }
    }

    if (isBusy) {
      show($)

      return { text: 'Prompt Enhancer is already working on a prompt. Finish it in the pane, or type /enhance cancel.' }
    }

    if (args === '') {
      await startCompose($)
      show($)

      return { text: 'Type the prompt you want to enhance in the pane.' }
    }

    await startFlow($, args, 'command', model)
    show($)

    return { text: 'Enhancing your prompt in the pane. Nothing is sent until you press Run.' }
  }).catch(($, e, next) => ({ text: next.error?.message ? `${FAILED} (${next.error.message})` : FAILED }))

  on('prompt.submit', async ($, e, next) => {
    const decision = decide(e, await getAuto($))

    if (decision.kind === 'pass') {
      return next(e)
    }

    if (decision.kind === 'strip') {
      return next({ ...e, text: decision.text })
    }

    const flow = await getFlow($)

    if (flow !== null && flow.step !== 'compose') {
      // A drop leaves the text in the box, so nothing is lost.
      return { drop: 'Prompt Enhancer is still open on another prompt; finish or cancel it first. Your new prompt stays in the box.' }
    }

    await startFlow($, e.text, 'auto', model)

    if (!(await openPane($))) {
      await cancel($, { isClosed: false })

      return { drop: 'Prompt Enhancer could not open its pane here, so your prompt is back in the box.' }
    }

    tidyAfterDrop($, e.text)

    return { drop: 'Opened in Prompt Enhancer.' }
  }).catch(($, e, next) => next(e))

  // Closing the pane by hand (Esc, the close mark) is Cancel: the original goes back in the box.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await cancel($, { isClosed: true })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: 'prompt-enhancer' }, ($, e) => renderPane($, e, model))
}
