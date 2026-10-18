import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, RenderSurface } from 'claude-code'

import type { Flow, HistoryEntry, Model, Models, Question, Rewrite, View } from '../types'
import { notFromYou } from './check'
import { decide } from './intercept'
import {
  isUnchanged,
  parseQuestions,
  parseRewrite,
  QUESTIONS_SYSTEM,
  questionsMessage,
  REWRITE_SYSTEM,
  rewriteMessage,
  type AnsweredPair,
} from './llm'
import { ACCENT, FAIL, fit, oneLine, OUTCOME, PASS, SIDE_BY_SIDE_MIN, stepIndex, STEPS, when } from './look'

// Every function that takes $ lives in this file: Claude Code 2.1.295 follows $ only into functions declared beside the hook, never across an import.

type $ = EngineInterface

const PANE = 'prompt-enhancer'
const TITLE = 'Prompt Enhancer'
const HISTORY_SIZE = 20
const TIMEOUT_MS = 60_000

const flowAtom = atom({ plugin: 'prompt-enhancer', key: 'flow' } as const, null)
const viewAtom = atom({ plugin: 'prompt-enhancer', key: 'view' } as const, 'flow')
const historyAtom = atom({ plugin: 'prompt-enhancer', key: 'history' } as const, [])
const autoAtom = atom({ plugin: 'prompt-enhancer', key: 'auto' } as const, false)
const settingsReturnAtom = atom({ plugin: 'prompt-enhancer', key: 'settingsReturn' } as const, 'flow')

const MODELS: Model[] = ['haiku', 'sonnet', 'opus']
const isModel = (value: unknown): value is Model => MODELS.includes(value as Model)

// In-flight calls by callId, so Cancel can abort them. Lost on reload, which is fine: the call is gone too.
const controllers = new Map<string, AbortController>()

let counter = 0
const newId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const blankFlow = (original: string, source: Flow['source']): Flow => ({
  id: newId(),
  original,
  source,
  step: 'reading',
  questions: [],
  answers: [],
  otherOpen: null,
  rewrite: null,
  flags: [],
  error: null,
  pending: null,
  note: null,
  draft: null,
})

function getFlow($: $): Promise<Flow | null> {
  return read($, flowAtom)
}

function getView($: $): Promise<View> {
  return read($, viewAtom)
}

function getHistory($: $): Promise<HistoryEntry[]> {
  return read($, historyAtom)
}

function getAuto($: $): Promise<boolean> {
  return read($, autoAtom)
}

let hasWarnedStore = false

// The store is a convenience: when its file cannot be read or written, the mod keeps working for the session without it.
function storeFailed($: $, error: unknown): void {
  if (hasWarnedStore) return
  hasWarnedStore = true
  const reason = error instanceof Error ? error.message : String(error)
  $.ui.log(`Prompt Enhancer could not use its saved settings and history, so it carries on without saving them this session. (${reason})`)
}

async function load($: $, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch (error) {
    storeFailed($, error)

    return undefined
  }
}

async function save($: $, key: string, value: unknown): Promise<void> {
  try {
    await $.store.set(key, value)
  } catch (error) {
    storeFailed($, error)
  }
}

/** Seeds the session's values from the store at start. */
async function restore($: $): Promise<boolean> {
  const isAuto = (await load($, 'auto')) === true
  const stored = await load($, 'history')
  await update($, autoAtom, () => isAuto)
  await update($, historyAtom, () => (Array.isArray(stored) ? (stored as HistoryEntry[]) : []))

  return isAuto
}

async function openPane($: $): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, rows: 24 })

  return opened.isPlaced
}

function setFlow($: $, fn: (flow: Flow | null) => Flow | null): Promise<Flow | null> {
  return update($, flowAtom, fn)
}

/** Applies `fn` only while the flow is still the one, waiting on the same call, that `callId` belongs to. */
function settle($: $, flowId: string, callId: string, fn: (flow: Flow) => Flow): Promise<Flow | null> {
  return setFlow($, flow => (flow?.id === flowId && flow.pending?.callId === callId ? fn(flow) : flow))
}

// ---- starting -------------------------------------------------------------

async function startCompose($: $): Promise<void> {
  await update($, viewAtom, () => 'flow' as View)
  await setFlow($, () => ({ ...blankFlow('', 'command'), step: 'compose' }))
}

async function startFlow($: $, original: string, source: Flow['source'], model: Models): Promise<void> {
  const flow = blankFlow(original, source)

  await update($, viewAtom, () => 'flow' as View)
  await setFlow($, () => ({ ...flow, pending: { kind: 'questions', callId: newId() } }))
  schedule($, model)
}

/** Runs the pending model call outside the dispatch that asked for it, so commands and presses answer at once. */
function schedule($: $, model: Models): void {
  $.clock.after(0, () => {
    runPending($, model).catch(() => undefined)
  })
}

// ---- the model calls ------------------------------------------------------

type CallResult<T> = { ok: true; value: T } | { ok: false; message: string }

async function ask<T>($: $, model: string, system: string, prompt: string, parse: (raw: string) => T | null, signal: AbortSignal): Promise<CallResult<T>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const r = await $.model.complete({ model, system, prompt, maxTokens: 2000, timeoutMs: TIMEOUT_MS }, { signal })

    if (!r.isAnswered) {
      if (r.reason === 'aborted') return { ok: false, message: 'The model took too long to answer.' }
      if (r.reason === 'empty-reply') return { ok: false, message: 'The model sent back an empty reply.' }
      if (r.reason === 'api-error') return { ok: false, message: `The model service returned an error (${r.error}${r.status ? `, ${r.status}` : ''}).` }

      return { ok: false, message: 'The model call did not finish.' }
    }

    const value = parse(r.text)

    if (value !== null) {
      return { ok: true, value }
    }
  }

  return { ok: false, message: "The model's reply could not be read." }
}

const answeredPairs = (flow: Pick<Flow, 'questions' | 'answers'>): AnsweredPair[] =>
  flow.questions.flatMap((q, i) => {
    const answer = flow.answers[i]

    return typeof answer === 'string' && answer.trim() !== '' ? [{ question: q.question, answer: answer.trim() }] : []
  })

async function runPending($: $, model: Models): Promise<void> {
  const flow = await read($, flowAtom)

  if (flow === null || flow.pending === null) {
    return
  }

  const { kind, callId } = flow.pending
  const controller = new AbortController()

  controllers.set(callId, controller)

  try {
    if (kind === 'questions') {
      const result = await ask<Question[]>($, model.questions, QUESTIONS_SYSTEM, questionsMessage(flow.original), parseQuestions, controller.signal)

      if (result.ok && result.value.length === 0) {
        // Nothing worth asking: straight on to the rewrite.
        await settle($, flow.id, callId, f => ({ ...f, step: 'rewriting', pending: { kind: 'rewrite', callId: newId() } }))
        await runPending($, model)

        return
      }

      await settle($, flow.id, callId, f =>
        result.ok
          ? { ...f, step: 'questions', questions: result.value, answers: [], pending: null }
          : { ...f, step: 'error', error: { message: result.message, retry: 'questions' }, pending: null },
      )

      return
    }

    const pairs = answeredPairs(flow)
    const result = await ask<Rewrite>($, model.rewrite, REWRITE_SYSTEM, rewriteMessage(flow.original, pairs), parseRewrite, controller.signal)

    await settle($, flow.id, callId, f =>
      result.ok
        ? {
            ...f,
            step: 'review',
            rewrite: result.value,
            flags: notFromYou(result.value.prompt, [f.original, ...pairs.map(p => p.answer)]),
            pending: null,
          }
        : { ...f, step: 'error', error: { message: result.message, retry: 'rewrite' }, pending: null },
    )
  } finally {
    controllers.delete(callId)
  }
}

function abortAll(): void {
  for (const controller of controllers.values()) controller.abort()
  controllers.clear()
}

// ---- the person's moves ---------------------------------------------------

async function answer($: $, index: number, value: string | null, model: Models): Promise<void> {
  const flow = await setFlow($, f => {
    if (f === null || f.step !== 'questions') return f
    const answers = [...f.answers]
    answers[index] = value

    return { ...f, answers, otherOpen: null }
  })

  if (flow !== null && flow.step === 'questions' && flow.questions.every((_, i) => flow.answers[i] !== undefined)) {
    await rewriteNow($, model)
  }
}

async function rewriteNow($: $, model: Models): Promise<void> {
  await setFlow($, f =>
    f === null || (f.step !== 'questions' && f.step !== 'error')
      ? f
      : { ...f, step: 'rewriting', error: null, otherOpen: null, pending: { kind: 'rewrite', callId: newId() } },
  )
  schedule($, model)
}

async function retry($: $, model: Models): Promise<void> {
  const flow = await read($, flowAtom)

  if (flow?.error?.retry === 'rewrite') {
    await rewriteNow($, model)

    return
  }

  await setFlow($, f => (f === null ? f : { ...f, step: 'reading', error: null, pending: { kind: 'questions', callId: newId() } }))
  schedule($, model)
}

async function remember($: $, flow: Flow, outcome: HistoryEntry['outcome']): Promise<void> {
  if (flow.rewrite === null || flow.source === 'history') {
    return
  }

  const entry: HistoryEntry = {
    id: flow.id,
    at: Date.now(),
    original: flow.original,
    questions: flow.questions,
    answers: answeredPairs(flow),
    rewrite: flow.rewrite,
    flags: flow.flags,
    outcome,
  }
  const list = await update($, historyAtom, list => [entry, ...list.filter(e => e.id !== entry.id)].slice(0, HISTORY_SIZE))

  await save($, 'history', list)
}

/** Empties the prompt box if it still holds `text`, and leaves anything else the person typed alone. */
async function clearBoxOf($: $, text: string): Promise<void> {
  const box = await $.prompt.read()

  if (text.trim() !== '' && box.text.trim() === text.trim()) {
    await $.prompt.fill({ text: '' })
  }
}

/** Claude Code puts a dropped prompt back in the box; once it has, take it out and hand the pane the keyboard. */
function tidyAfterDrop($: $, text: string): void {
  $.clock.after(150, () => {
    clearBoxOf($, text)
      .then(() => openPane($))
      .catch(() => undefined)
  })
}

/** Sends `text` as the person's own prompt and closes the pane. */
async function send($: $, text: string, outcome: HistoryEntry['outcome']): Promise<void> {
  const flow = await read($, flowAtom)

  if (flow !== null) {
    await remember($, flow, outcome).catch(() => undefined)
    await clearBoxOf($, flow.original).catch(() => undefined)
  }

  abortAll()
  await setFlow($, () => null)
  await $.ui.close({ id: PANE })

  try {
    // A plugin's submit arrives with a plugin origin, so automatic mode never catches it again.
    await $.prompt.submit({ text, asUser: true })
  } catch {
    await $.prompt.fill({ text })
    $.ui.log('Prompt Enhancer could not send the prompt, so it is back in the prompt box.')
  }
}

/** Cancel: stop any call, close the pane (unless the person already did) and put the original back. */
async function cancel($: $, options: { isClosed: boolean }): Promise<void> {
  const flow = await read($, flowAtom)

  abortAll()

  if (flow !== null) {
    await remember($, flow, 'cancelled').catch(() => undefined)
  }

  await setFlow($, () => null)
  await update($, viewAtom, () => 'flow' as View)

  if (!options.isClosed) {
    await $.ui.close({ id: PANE })
  }

  if (flow !== null && flow.source !== 'history' && flow.original.trim() !== '') {
    await $.prompt.fill({ text: flow.original })
  }
}

async function copy($: $, text: string, surface: RenderSurface): Promise<void> {
  const r = await $.ui.copy({ text, surface })

  await setFlow($, f => (f === null ? f : { ...f, note: r.isCopied ? 'Copied.' : 'Could not copy here.' }))
}

async function openHistory($: $): Promise<void> {
  await update($, viewAtom, () => 'history' as View)
}

async function reopen($: $, entry: HistoryEntry): Promise<void> {
  await setFlow($, () => ({
    ...blankFlow(entry.original, 'history'),
    step: 'review',
    questions: entry.questions,
    answers: entry.questions.map(q => entry.answers.find(a => a.question === q.question)?.answer ?? null),
    rewrite: entry.rewrite,
    flags: entry.flags,
  }))
  await update($, viewAtom, () => 'flow' as View)
}

async function setAuto($: $, isOn: boolean): Promise<void> {
  await update($, autoAtom, () => isOn)
  await save($, 'auto', isOn)
  $.ui.status(isOn ? 'Prompt Enhancer: auto' : undefined)
}

async function clearHistory($: $): Promise<void> {
  await update($, historyAtom, () => [])
  await save($, 'history', [])
}

async function openSettings($: $): Promise<void> {
  const view = await getView($)

  if (view !== 'settings') await update($, settingsReturnAtom, () => view)
  await update($, viewAtom, () => 'settings' as View)
}

async function closeSettings($: $): Promise<void> {
  const settingsReturn = await read($, settingsReturnAtom)

  if (settingsReturn === 'flow' && (await getFlow($)) === null) {
    await update($, viewAtom, () => 'flow' as View)
    await $.ui.close({ id: PANE })

    return
  }

  await update($, viewAtom, () => settingsReturn)
}

const CONFIG_KEY: Record<keyof Models, string> = { questions: 'prompt-enhancer.questionsModel', rewrite: 'prompt-enhancer.rewriteModel' }

// The pane writes the /config row itself, so the two can never disagree; the engine then reloads this module with the new options.
async function setModel($: $, step: keyof Models, value: Model): Promise<void> {
  const r = await $.config.set({ key: CONFIG_KEY[step], value }).catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))

  if (r.deny !== undefined) $.ui.toast(`Prompt Enhancer could not change the model: ${r.deny}`)
}

const isClear = (flow: Flow) => flow.rewrite !== null && isUnchanged(flow.original, flow.rewrite.prompt)

// ---- drawing ----------------------------------------------------------------

const MODEL_NAME: Record<Model, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }
const MODEL_NOTE: Record<Model, string> = {
  haiku: 'fastest, and stays closest to your exact words',
  sonnet: 'fixes grammar and reads most naturally',
  opus: 'the most careful, and the slowest',
}

/** Draws the pane. Reads state only; every change happens in a handler. */
async function renderPane($: EngineInterface, e: RenderInput<'Pane'>, model: Models): Promise<RenderElement> {
  const ui = $.ui.resolve(e)
  const { Box, Text, Button } = ui
  const Input = 'Input' in ui ? ui.Input : undefined
  const padX = e.props.bodyColumns >= 60 ? 2 : 1
  // Everything below lays out in the frame's inner width, inside the padding.
  const cols = Math.max(20, e.props.bodyColumns - padX * 2)
  const surface = e.surface

  const flow = await getFlow($)
  const view = await getView($)

  // ---- the page kit: a heading row, then sections under a ruled label ----

  const rule = (left: string, right = '') => {
    const room = cols - left.length - (left ? 1 : 0)
    const tail = right && room - right.length - 3 >= 4 ? right : ''
    const fill = Math.max(2, room - (tail ? tail.length + 3 : 0))

    return { tail, fill: '─'.repeat(fill) }
  }

  const section = (title: string, hint = '') => {
    const r = rule(title, hint)

    return (
      <Text wrap="truncate-end">
        <Text bold dimColor>
          {title}
        </Text>
        <Text dimColor>{` ${r.fill}`}</Text>
        {r.tail ? <Text dimColor italic>{` ${r.tail} ─`}</Text> : null}
      </Text>
    )
  }

  const pageHead = (title: string, right: RenderElement | null = null) => (
    <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
      <Text bold color={ACCENT} wrap="truncate-end">{`◆ ${title}`}</Text>
      {right}
    </Box>
  )

  const action = (key: string, label: string, onPress: () => unknown, hotkey?: string, isMain = false) => (
    <Button key={key} plain label={label} hotkey={hotkey} {...(isMain ? { variant: 'primary' as const } : {})} onPress={() => void onPress()} />
  )

  const quiet = (key: string, label: string, onPress: () => unknown, hotkey?: string) => (
    <Button key={key} plain dimColor label={label} hotkey={hotkey} onPress={() => void onPress()} />
  )

  const chip = (key: string, label: string, isOn: boolean, onPress: () => unknown, hotkey?: string) => (
    <Button key={key} plain hotkey={hotkey} onPress={() => void onPress()}>
      {isOn ? <Text inverse bold color={ACCENT}>{` ${label} `}</Text> : <Text dimColor>{` ${label} `}</Text>}
    </Button>
  )

  const row = (...children: (RenderElement | null)[]) => (
    <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
      {children.filter((c): c is RenderElement => c !== null)}
    </Box>
  )

  const card = (label: string, text: string, width: number | string, isAccent = false) => (
    <Box flexDirection="column" borderStyle="round" {...(isAccent ? { borderColor: ACCENT } : { borderDimColor: true })} paddingX={padX} width={width}>
      <Text bold {...(isAccent ? { color: ACCENT } : { dimColor: true })}>
        {label}
      </Text>
      <Text>{text}</Text>
    </Box>
  )

  const cancelButton = () => quiet('cancel', 'Cancel', () => cancel($, { isClosed: false }), 'x')

  // A one-row field cuts a long prompt off at the edge, so a field holding one is as tall as its text, within the pane.
  const rowsFor = (text: string) => {
    const lines = text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / Math.max(10, cols - 8))), 0)

    return Math.max(3, Math.min(lines, e.props.scroll.bodyRows - 14))
  }

  // ---- the frame: header with the Settings button, the body, a footer of keys ----

  const isSettings = view === 'settings'
  const current = view === 'flow' && flow !== null ? stepIndex(flow) : null
  const busy =
    view !== 'flow' || flow === null
      ? ''
      : flow.step === 'reading'
        ? `◌ reading with ${MODEL_NAME[model.questions]}`
        : flow.step === 'rewriting'
          ? `◌ rewriting with ${MODEL_NAME[model.rewrite]}`
          : ''
  const busyRule = rule('', busy)

  const tracker = (at: number) =>
    cols < 58 ? (
      <Text>
        <Text dimColor>{`Step ${at + 1} of ${STEPS.length}  `}</Text>
        <Text bold color={ACCENT}>
          {STEPS[at]}
        </Text>
      </Text>
    ) : (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {STEPS.map((label, i) =>
          i < at ? (
            <Text key={`step-${i}`} color={PASS}>{`✓ ${label}`}</Text>
          ) : i === at ? (
            <Text key={`step-${i}`} inverse bold color={ACCENT}>{` ${i + 1} ${label} `}</Text>
          ) : (
            <Text key={`step-${i}`} dimColor>{`${i + 1} ${label}`}</Text>
          ),
        )}
      </Box>
    )

  const header = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
        <Text bold color={ACCENT}>
          ◆ Prompt Enhancer
        </Text>
        <Box flexDirection="row" columnGap={2}>
          {cols >= 72 ? (
            <Text>
              <Text dimColor>questions </Text>
              <Text bold>{MODEL_NAME[model.questions]}</Text>
              <Text dimColor>   rewrite </Text>
              <Text bold>{MODEL_NAME[model.rewrite]}</Text>
            </Text>
          ) : null}
          <Button key="settings" label={isSettings ? 'Close settings' : '⚙ Settings'} hotkey="m" onPress={() => void (isSettings ? closeSettings($) : openSettings($))} />
        </Box>
      </Box>
      <Box flexDirection="column">
        {current === null ? null : tracker(current)}
        {/* Work in progress rides on the rule, so the page below never shifts. */}
        <Text wrap="truncate-end">
          <Text dimColor>{busyRule.fill}</Text>
          {busyRule.tail ? <Text italic color={ACCENT}>{` ${busyRule.tail} `}</Text> : null}
          {busyRule.tail ? <Text dimColor>─</Text> : null}
        </Text>
      </Box>
    </Box>
  )

  const footer = (
    <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
      {cols >= 64 ? <Text dimColor>Nothing is sent until you press Run</Text> : null}
      <Text dimColor>Tab moves · Enter presses · Esc cancels</Text>
    </Box>
  )

  // In the dock the page fills the frame, so the footer sits on its bottom edge.
  const fill = e.props.placement === 'dock' ? { minHeight: e.props.scroll.bodyRows } : {}

  const page = (...body: (RenderElement | null | false)[]) => (
    <Box flexDirection="column" paddingX={padX} paddingY={1} {...fill}>
      {header}
      <Box flexDirection="column" flexGrow={1} marginTop={1} marginBottom={1} gap={1}>
        {body.filter((b): b is RenderElement => b !== null && b !== false)}
      </Box>
      {footer}
    </Box>
  )

  // ---- settings ----

  if (isSettings) {
    const picker = (step: keyof Models, label: string, hotkey: string) => {
      const next = MODELS[(MODELS.indexOf(model[step]) + 1) % MODELS.length] ?? 'haiku'

      return (
        <Box key={`pick-${step}`} flexDirection="row" flexWrap="wrap" columnGap={1}>
          {/* The label's hotkey steps to the next model. */}
          <Button key={`${step}-step`} plain hotkey={hotkey} onPress={() => void setModel($, step, next)}>
            <Text dimColor>{label.padEnd(10)}</Text>
          </Button>
          {MODELS.map(m => chip(`${step}-${m}`, model[step] === m ? `✓ ${MODEL_NAME[m]}` : MODEL_NAME[m], model[step] === m, () => setModel($, step, m)))}
        </Box>
      )
    }

    return page(
      pageHead('Settings'),
      <Box flexDirection="column" gap={1}>
        {section('MODELS', 'saved in /config')}
        <Box flexDirection="column">
          {picker('questions', 'Questions', 'q')}
          {picker('rewrite', 'Rewrite', 'w')}
        </Box>
        <Box flexDirection="column">
          {MODELS.map(m => (
            <Text key={`note-${m}`} wrap="truncate-end">
              <Text bold>{MODEL_NAME[m].padEnd(8)}</Text>
              <Text dimColor>{MODEL_NOTE[m]}</Text>
            </Text>
          ))}
        </Box>
        <Text dimColor italic>
          These are the same settings as in /config: a change in either place shows in both.
        </Text>
      </Box>,
      row(action('settings-done', 'Done', () => closeSettings($), 'd', true)),
    )
  }

  // ---- history ----

  if (view === 'history') {
    const history = await getHistory($)

    return page(
      pageHead('History', <Text dimColor>{`${history.length} of ${HISTORY_SIZE}`}</Text>),
      history.length === 0 ? (
        <Text dimColor italic>
          No enhanced prompts yet.
        </Text>
      ) : (
        <Box flexDirection="column">
          {history.map(entry => {
            const outcome = OUTCOME[entry.outcome]

            return (
              <Button key={`h-${entry.id}`} plain onPress={() => void reopen($, entry)}>
                <Text color={entry.outcome === 'sent-rewrite' ? PASS : undefined} dimColor={entry.outcome === 'cancelled'}>{`${outcome.mark} `}</Text>
                <Text dimColor>{`${when(entry.at)}  `}</Text>
                {fit(oneLine(entry.original), Math.max(8, cols - 34)).padEnd(Math.max(8, cols - 34))}
                <Text dimColor>{`  ${outcome.label}`}</Text>
              </Button>
            )
          })}
        </Box>
      ),
      row(quiet('close', 'Close', () => cancel($, { isClosed: false }), 'x')),
    )
  }

  if (flow === null) {
    return page(
      pageHead('Nothing to enhance'),
      <Text dimColor italic>
        Type /enhance followed by a prompt.
      </Text>,
    )
  }

  const promptCard = card('YOUR PROMPT', flow.original, cols)

  // ---- compose ----

  if (flow.step === 'compose') {
    return page(
      pageHead('New prompt'),
      Input === undefined ? (
        <Text dimColor italic>
          This surface has no text field. Type /enhance followed by your prompt instead.
        </Text>
      ) : (
        <Input
          key="compose"
          rows={3}
          autoFocus
          placeholder="Type the prompt you want to enhance"
          submitLabel="enhance"
          onSubmit={value => {
            if (value.trim() !== '') void startFlow($, value.trim(), 'command', model)
          }}
        />
      ),
      row(cancelButton()),
    )
  }

  // ---- reading ----

  if (flow.step === 'reading') {
    return page(
      pageHead('Your prompt'),
      promptCard,
      <Text dimColor italic>
        Looking for gaps only you can fill.
      </Text>,
      row(cancelButton()),
    )
  }

  // ---- error ----

  if (flow.step === 'error') {
    return page(
      pageHead('Something went wrong'),
      <Box flexDirection="column" borderStyle="round" borderColor={FAIL} paddingX={padX} width={cols}>
        <Text bold color={FAIL}>{`✗ ${flow.error?.message ?? 'Something went wrong.'}`}</Text>
        <Text dimColor>Your prompt is safe.</Text>
      </Box>,
      row(
        action('retry', 'Try again', () => retry($, model), 't', true),
        action('original', 'Send original', () => send($, flow.original, 'sent-original'), 'o'),
        cancelButton(),
      ),
    )
  }

  // ---- questions ----

  if (flow.step === 'questions') {
    const done = flow.questions.filter((_, i) => flow.answers[i] !== undefined).length
    const firstOpen = flow.questions.findIndex((_, i) => flow.answers[i] === undefined)

    return page(
      pageHead('Questions', <Text dimColor>{`${done} of ${flow.questions.length} answered`}</Text>),
      promptCard,
      ...flow.questions.map((q, i) => {
        const chosen = flow.answers[i]
        const isOpen = chosen === undefined
        const isFirstOpen = i === firstOpen
        const isTyped = typeof chosen === 'string' && !q.options.includes(chosen)
        const badge = isOpen ? (
          <Text bold color={ACCENT}>{`${i + 1}.`}</Text>
        ) : chosen === null ? (
          <Text dimColor>–</Text>
        ) : (
          <Text color={PASS}>✓</Text>
        )

        return (
          <Box key={`q-${i}`} flexDirection="column">
            <Text>
              {badge}
              <Text bold={isOpen} dimColor={!isOpen}>{` ${q.question}`}</Text>
              {chosen === null ? <Text dimColor italic> skipped</Text> : null}
            </Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={3}>
              {q.options.map((option, j) => chip(`a-${i}-${j}`, option, chosen === option, () => answer($, i, option, model), isFirstOpen ? String(j + 1) : undefined))}
              {Input === undefined
                ? null
                : chip(`other-${i}`, isTyped ? chosen : 'Other…', isTyped, () => setFlow($, f => (f === null ? f : { ...f, otherOpen: i })), isFirstOpen ? 'o' : undefined)}
              {isOpen ? quiet(`skip-${i}`, 'Skip', () => answer($, i, null, model), isFirstOpen ? 's' : undefined) : null}
            </Box>
            {Input !== undefined && flow.otherOpen === i ? (
              <Box paddingLeft={3}>
                <Input
                  key={`other-input-${i}`}
                  autoFocus
                  placeholder="Type your answer"
                  submitLabel="answer"
                  onSubmit={value => void answer($, i, value.trim() === '' ? null : value.trim(), model)}
                />
              </Box>
            ) : null}
          </Box>
        )
      }),
      row(action('rewrite-now', done === 0 ? 'Skip the questions, rewrite now' : 'Skip the rest, rewrite now', () => rewriteNow($, model), 'w', true), cancelButton()),
    )
  }

  // ---- rewriting ----

  if (flow.step === 'rewriting') {
    const pairs = answeredPairs(flow)

    return page(
      pageHead('Rewrite'),
      promptCard,
      pairs.length === 0 ? null : (
        <Box flexDirection="column">
          {section('YOUR ANSWERS', `${pairs.length}`)}
          {pairs.map((p, i) => (
            <Text key={`pair-${i}`} wrap="truncate-end">
              <Text color={PASS}>✓ </Text>
              <Text dimColor>{`${p.question} `}</Text>
              {p.answer}
            </Text>
          ))}
        </Box>
      ),
      <Text dimColor italic>
        Writing the rewrite from your words and answers only.
      </Text>,
      row(cancelButton()),
    )
  }

  // ---- review and edit ----

  const rewrite = flow.rewrite?.prompt ?? flow.original
  const changes = flow.rewrite?.changes ?? []
  const asked = flow.questions.length
  const answered = answeredPairs(flow).length
  const clear = isClear(flow)

  if (flow.step === 'editing' && Input !== undefined) {
    const draft = flow.draft ?? rewrite
    const runDraft = (text: string) => send($, text.trim() === '' ? rewrite : text.trim(), 'sent-rewrite')
    // Only the terminal hands a Client the keyboard; the desktop app's own text box wraps by itself.
    const Client = surface === 'terminal' && 'Client' in ui ? ui.Client : undefined
    const boxRows = rowsFor(draft)

    return page(
      pageHead('Edit the rewrite'),
      Client === undefined ? (
        <Input key="edit" autoFocus value={draft} rows={boxRows} submitLabel="run" onSubmit={value => void runDraft(value)} />
      ) : (
        <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} width={cols}>
          <Client key="edit" module="./textarea.tsx" props={{ id: flow.id, text: draft, rows: boxRows, columns: cols - 4 }} height={boxRows} />
        </Box>
      ),
      <Text dimColor italic>
        {Client === undefined ? 'Enter runs it.' : 'Click in the box to type · Enter runs it · Shift+Enter adds a line · Esc leaves the box'}
      </Text>,
      row(
        action('run-edit', 'Run it', () => runDraft(draft), 'r', true),
        action('back', 'Back', () => setFlow($, f => (f === null ? f : { ...f, step: 'review' })), 'b'),
        cancelButton(),
      ),
    )
  }

  const stats = [asked === 0 ? 'No questions needed' : `Questions answered ${answered} of ${asked}`, `Changes ${changes.length}`].join('  ·  ')
  const isWide = cols >= SIDE_BY_SIDE_MIN
  const half = Math.floor((cols - 1) / 2)

  return page(
    pageHead('Review', <Text dimColor>{stats}</Text>),
    clear ? (
      <Text color={PASS}>✓ Your prompt is already clear.</Text>
    ) : flow.flags.length === 0 ? (
      <Text color={PASS}>✓ Nothing new: every specific comes from your words or answers.</Text>
    ) : (
      <Text color={FAIL}>{`⚠ Not from you, check before running: ${flow.flags.join(', ')}`}</Text>
    ),
    <Box flexDirection="column">
      {row(
        action('run', 'Run it', () => send($, rewrite, 'sent-rewrite'), 'r', !clear),
        Input === undefined ? null : action('edit', 'Edit', () => setFlow($, f => (f === null ? f : { ...f, step: 'editing', note: null, draft: f.rewrite?.prompt ?? f.original })), 'e'),
        action('copy', 'Copy', () => copy($, rewrite, surface), 'c'),
        action('original', 'Send original', () => send($, flow.original, 'sent-original'), 'o', clear),
        cancelButton(),
      )}
      {flow.note === null ? null : <Text dimColor italic>{flow.note}</Text>}
    </Box>,
    changes.length === 0 ? null : (
      <Box flexDirection="column">
        {section('WHAT CHANGED', `${changes.length}`)}
        {changes.slice(0, 8).map((change, i) => (
          <Text key={`change-${i}`}>
            <Text dimColor>· </Text>
            {change}
          </Text>
        ))}
      </Box>
    ),
    isWide ? (
      <Box flexDirection="row" columnGap={1} width={cols}>
        {card('YOUR PROMPT', flow.original, half)}
        {card('ENHANCED', rewrite, half, true)}
      </Box>
    ) : (
      <Box flexDirection="column" width={cols}>
        {card('YOUR PROMPT', flow.original, cols)}
        {card('ENHANCED', rewrite, cols, true)}
      </Box>
    ),
  )
}

// ---- hooks ------------------------------------------------------------------

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
  // Tested pairing: Haiku asks fewer, better questions; Sonnet writes the cleanest faithful rewrite. The pane's Model settings override these per step.
  const model: Models = {
    questions: isModel(options.questionsModel) ? options.questionsModel : 'haiku',
    rewrite: isModel(options.rewriteModel) ? options.rewriteModel : 'sonnet',
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({
      name: 'enhance',
      description: 'Sharpen a prompt before sending it, using only your words and answers',
      argumentHint: '[prompt | on | off | history | settings | cancel]',
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

    if (word === 'settings') {
      await openSettings($)
      show($)

      return { text: 'Pick the models in the Prompt Enhancer pane.' }
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

  // The edit text area reports each change, so Run it sends what was typed; its Enter runs it.
  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    const data = e.data as { id?: unknown; text?: unknown; action?: unknown } | null

    if (!e.module.endsWith('textarea.tsx') || typeof data?.text !== 'string') return next(e)

    const text = data.text
    const flow = await setFlow($, f => (f === null || f.id !== data.id || f.step !== 'editing' ? f : { ...f, draft: text }))

    if (data.action === 'run' && flow !== null && flow.id === data.id && flow.step === 'editing') {
      await send($, text.trim() === '' ? (flow.rewrite?.prompt ?? flow.original) : text.trim(), 'sent-rewrite')
    }

    return {}
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
