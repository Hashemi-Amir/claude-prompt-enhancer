import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, RenderSurface } from 'claude-code'

import type { Flow, HistoryEntry, Question, Rewrite, View } from '../types'
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
import { AMBER, fit, GOLD, GREEN, HEADING, INK, LINE, MUTED, oneLine, OUTCOME, SIDE_BY_SIDE_MIN, stepIndex, STEPS, TEXT, when } from './look'

// Every function that takes $ lives in this file: Claude Code 2.1.295 follows $ only into functions declared beside the hook, never across an import.

type $ = EngineInterface

const PANE = 'prompt-enhancer'
const TITLE = 'Prompt Enhancer'
const HISTORY_SIZE = 20
const TIMEOUT_MS = 30_000

const flowAtom = atom({ plugin: 'prompt-enhancer', key: 'flow' } as const, null)
const viewAtom = atom({ plugin: 'prompt-enhancer', key: 'view' } as const, 'flow')
const historyAtom = atom({ plugin: 'prompt-enhancer', key: 'history' } as const, [])
const autoAtom = atom({ plugin: 'prompt-enhancer', key: 'auto' } as const, false)

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

async function startFlow($: $, original: string, source: Flow['source'], model: string): Promise<void> {
  const flow = blankFlow(original, source)

  await update($, viewAtom, () => 'flow' as View)
  await setFlow($, () => ({ ...flow, pending: { kind: 'questions', callId: newId() } }))
  schedule($, model)
}

/** Runs the pending model call outside the dispatch that asked for it, so commands and presses answer at once. */
function schedule($: $, model: string): void {
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

async function runPending($: $, model: string): Promise<void> {
  const flow = await read($, flowAtom)

  if (flow === null || flow.pending === null) {
    return
  }

  const { kind, callId } = flow.pending
  const controller = new AbortController()

  controllers.set(callId, controller)

  try {
    if (kind === 'questions') {
      const result = await ask<Question[]>($, model, QUESTIONS_SYSTEM, questionsMessage(flow.original), parseQuestions, controller.signal)

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
    const result = await ask<Rewrite>($, model, REWRITE_SYSTEM, rewriteMessage(flow.original, pairs), parseRewrite, controller.signal)

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

async function answer($: $, index: number, value: string | null, model: string): Promise<void> {
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

async function rewriteNow($: $, model: string): Promise<void> {
  await setFlow($, f =>
    f === null || (f.step !== 'questions' && f.step !== 'error')
      ? f
      : { ...f, step: 'rewriting', error: null, otherOpen: null, pending: { kind: 'rewrite', callId: newId() } },
  )
  schedule($, model)
}

async function retry($: $, model: string): Promise<void> {
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

const isClear = (flow: Flow) => flow.rewrite !== null && isUnchanged(flow.original, flow.rewrite.prompt)

// ---- drawing ----------------------------------------------------------------

/** Draws the pane. Reads state only; every change happens in a handler. */
async function renderPane($: EngineInterface, e: RenderInput<'Pane'>, model: string): Promise<RenderElement> {
  const ui = $.ui.resolve(e)
  const { Box, Text, Button } = ui
  const Input = 'Input' in ui ? ui.Input : undefined
  const cols = Math.max(20, e.props.bodyColumns)
  const surface = e.surface

  const flow = await getFlow($)
  const view = await getView($)

  // ---- pieces ----

  const header = (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={TEXT}>
        {HEADING}
      </Text>
      <Text>
        <Text color={GOLD}>{'━'.repeat(Math.min(HEADING.length, cols))}</Text>
        <Text color={LINE}>{'─'.repeat(Math.max(0, cols - HEADING.length))}</Text>
      </Text>
    </Box>
  )

  const heading = (label: string) => (
    <Text>
      <Text color={MUTED} bold>
        {label.toUpperCase()}
      </Text>
      <Text color={LINE}> {'─'.repeat(Math.max(0, cols - label.length - 1))}</Text>
    </Text>
  )

  const primary = (key: string, label: string, onPress: () => unknown, hotkey?: string) => (
    <Button key={key} plain hotkey={hotkey} onPress={() => void onPress()}>
      <Text backgroundColor={GOLD} color={INK} bold>{` ${label} `}</Text>
    </Button>
  )

  const secondary = (key: string, label: string, onPress: () => unknown, hotkey?: string) => (
    <Button key={key} plain hotkey={hotkey} onPress={() => void onPress()}>
      <Text backgroundColor={LINE} color={TEXT}>{` ${label} `}</Text>
    </Button>
  )

  const quiet = (key: string, label: string, onPress: () => unknown, hotkey?: string) => (
    <Button key={key} plain hotkey={hotkey} onPress={() => void onPress()}>
      <Text color={MUTED}>{label}</Text>
    </Button>
  )

  const row = (...children: RenderElement[]) => (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={0}>
      {children}
    </Box>
  )

  const card = (label: string, text: string, width: number | string, isGold = false) => (
    <Box flexDirection="column" borderStyle="round" borderColor={isGold ? GOLD : LINE} paddingX={1} width={width}>
      <Text color={isGold ? GOLD : MUTED} bold>
        {label.toUpperCase()}
      </Text>
      <Text color={TEXT}>{text}</Text>
    </Box>
  )

  const cancelButton = () => quiet('cancel', 'Cancel', () => cancel($, { isClosed: false }), 'x')

  const tracker = (current: number) => {
    const isCompact = cols < 58

    if (isCompact) {
      return (
        <Text>
          <Text color={MUTED}>{`Step ${current + 1} of ${STEPS.length}  `}</Text>
          <Text color={GOLD} bold>
            {STEPS[current]}
          </Text>
        </Text>
      )
    }

    return (
      <Text>
        {STEPS.flatMap((label, i) => {
          const part =
            i < current ? (
              <Text color={GREEN}>{`✓ ${label}`}</Text>
            ) : i === current ? (
              <Text color={GOLD} bold>{`${i + 1} ${label}`}</Text>
            ) : (
              <Text color={MUTED}>{`${i + 1} ${label}`}</Text>
            )

          return i === 0 ? [part] : [<Text color={LINE}>{'  ─  '}</Text>, part]
        })}
      </Text>
    )
  }

  const frame = (current: number | null, ...body: (RenderElement | null | false)[]) => (
    <Box flexDirection="column" width={cols}>
      {header}
      {current === null ? null : tracker(current)}
      {current === null ? null : <Text> </Text>}
      {body.filter((b): b is RenderElement => b !== null && b !== false)}
    </Box>
  )

  // ---- history ----

  if (view === 'history') {
    const history = await getHistory($)

    return frame(
      null,
      heading('History'),
      history.length === 0 ? (
        <Text color={MUTED}>No enhanced prompts yet.</Text>
      ) : (
        <Box flexDirection="column">
          {history.map(entry => (
            <Button key={`h-${entry.id}`} plain onPress={() => void reopen($, entry)}>
              <Text color={MUTED}>{`${when(entry.at)}  ${OUTCOME[entry.outcome].padEnd(13)} `}</Text>
              <Text color={TEXT}>{fit(oneLine(entry.original), Math.max(8, cols - 34))}</Text>
            </Button>
          ))}
        </Box>
      ),
      <Text> </Text>,
      row(quiet('close', 'Close', () => cancel($, { isClosed: false }), 'x')),
    )
  }

  if (flow === null) {
    return frame(null, <Text color={MUTED}>Nothing to enhance right now. Type /enhance followed by a prompt.</Text>)
  }

  const current = stepIndex(flow)

  // ---- compose ----

  if (flow.step === 'compose') {
    return frame(
      current,
      heading('Your prompt'),
      Input === undefined ? (
        <Text color={MUTED}>This surface has no text field. Type /enhance followed by your prompt instead.</Text>
      ) : (
        <Input
          key="compose"
          autoFocus
          placeholder="Type the prompt you want to enhance"
          submitLabel="enhance"
          onSubmit={value => {
            if (value.trim() !== '') void startFlow($, value.trim(), 'command', model)
          }}
        />
      ),
      <Text> </Text>,
      row(cancelButton()),
    )
  }

  // ---- reading ----

  if (flow.step === 'reading') {
    return frame(
      current,
      card('Your prompt', flow.original, cols),
      <Text color={MUTED}>Reading your prompt and looking for gaps only you can fill.</Text>,
      <Text> </Text>,
      row(cancelButton()),
    )
  }

  // ---- error ----

  if (flow.step === 'error') {
    return frame(
      current,
      <Box flexDirection="column" borderStyle="round" borderColor={AMBER} paddingX={1} width={cols}>
        <Text color={TEXT} bold>
          Your prompt is safe.
        </Text>
        <Text color={AMBER}>{flow.error?.message ?? 'Something went wrong.'}</Text>
      </Box>,
      row(
        primary('retry', 'Try again', () => retry($, model), 't'),
        secondary('original', 'Send original', () => send($, flow.original, 'sent-original'), 'o'),
        cancelButton(),
      ),
    )
  }

  // ---- questions ----

  if (flow.step === 'questions') {
    const done = flow.questions.filter((_, i) => flow.answers[i] !== undefined).length
    const firstOpen = flow.questions.findIndex((_, i) => flow.answers[i] === undefined)

    return frame(
      current,
      card('Your prompt', flow.original, cols),
      heading('Questions'),
      <Text>
        <Text color={TEXT}>{`${done} of ${flow.questions.length} answered  `}</Text>
      </Text>,
      ...flow.questions.map((q, i) => {
        const chosen = flow.answers[i]
        const isOpen = chosen === undefined
        const isFirstOpen = i === firstOpen
        const badge =
          chosen === undefined ? (
            <Text backgroundColor={GOLD} color={INK} bold>{` ${i + 1} `}</Text>
          ) : chosen === null ? (
            <Text color={MUTED}>{' – '}</Text>
          ) : (
            <Text color={GREEN} bold>{' ✓ '}</Text>
          )

        return (
          <Box key={`q-${i}`} flexDirection="column" marginTop={1}>
            <Text>
              {badge}
              <Text color={TEXT}>{` ${q.question}`}</Text>
              {chosen === null ? <Text color={MUTED}> (skipped)</Text> : null}
            </Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={4}>
              {q.options.map((option, j) =>
                chosen === option
                  ? primary(`a-${i}-${j}`, option, () => answer($, i, option, model))
                  : secondary(`a-${i}-${j}`, option, () => answer($, i, option, model), isFirstOpen ? String(j + 1) : undefined),
              )}
              {Input === undefined
                ? null
                : typeof chosen === 'string' && !q.options.includes(chosen)
                  ? primary(`other-${i}`, chosen, () => setFlow($, f => (f === null ? f : { ...f, otherOpen: i })))
                  : secondary(`other-${i}`, 'Other (type it)', () => setFlow($, f => (f === null ? f : { ...f, otherOpen: i })), isFirstOpen ? 'o' : undefined)}
              {isOpen ? quiet(`skip-${i}`, 'Skip', () => answer($, i, null, model), isFirstOpen ? 's' : undefined) : null}
            </Box>
            {Input !== undefined && flow.otherOpen === i ? (
              <Box paddingLeft={4}>
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
      <Text> </Text>,
      row(primary('rewrite-now', done === 0 ? 'Skip the questions, rewrite now' : 'Skip the rest, rewrite now', () => rewriteNow($, model), 'w'), cancelButton()),
    )
  }

  // ---- rewriting ----

  if (flow.step === 'rewriting') {
    const pairs = answeredPairs(flow)

    return frame(
      current,
      card('Your prompt', flow.original, cols),
      pairs.length === 0 ? null : heading('Your answers'),
      ...pairs.map(p => (
        <Text color={TEXT}>
          <Text color={GREEN}>{'✓ '}</Text>
          {fit(`${p.question} ${p.answer}`, cols - 2)}
        </Text>
      )),
      <Text color={MUTED}>Writing the rewrite from your words and answers only.</Text>,
      <Text> </Text>,
      row(cancelButton()),
    )
  }

  // ---- review and edit ----

  const rewrite = flow.rewrite?.prompt ?? flow.original
  const changes = flow.rewrite?.changes ?? []
  const asked = flow.questions.length
  const answered = answeredPairs(flow).length
  const clear = isClear(flow)
  const stats = [
    asked === 0 ? 'No questions needed' : `Questions answered ${answered} of ${asked}`,
    `Changes ${changes.length}`,
  ].join('  ·  ')

  if (flow.step === 'editing' && Input !== undefined) {
    return frame(
      current,
      heading('Edit the rewrite'),
      <Input key="edit" autoFocus value={rewrite} submitLabel="run" onSubmit={value => void send($, value.trim() === '' ? rewrite : value.trim(), 'sent-rewrite')} />,
      <Text color={MUTED}>Enter runs it.</Text>,
      <Text> </Text>,
      row(secondary('back', 'Back', () => setFlow($, f => (f === null ? f : { ...f, step: 'review' })), 'b'), cancelButton()),
    )
  }

  const isWide = cols >= SIDE_BY_SIDE_MIN
  const half = Math.floor((cols - 1) / 2)

  return frame(
    current,
    <Text color={TEXT}>{fit(stats, cols)}</Text>,
    clear ? (
      <Text color={GREEN}>Your prompt is already clear.</Text>
    ) : flow.flags.length === 0 ? (
      <Text color={GREEN}>Nothing new: every specific comes from your words or answers.</Text>
    ) : (
      <Text color={AMBER}>{`Not from you, check before running: ${flow.flags.join(', ')}`}</Text>
    ),
    <Text> </Text>,
    row(
      clear ? secondary('run', 'Run it', () => send($, rewrite, 'sent-rewrite'), 'r') : primary('run', 'Run it', () => send($, rewrite, 'sent-rewrite'), 'r'),
      ...(Input === undefined ? [] : [secondary('edit', 'Edit', () => setFlow($, f => (f === null ? f : { ...f, step: 'editing', note: null })), 'e')]),
      secondary('copy', 'Copy', () => copy($, rewrite, surface), 'c'),
      clear ? primary('original', 'Send original', () => send($, flow.original, 'sent-original'), 'o') : secondary('original', 'Send original', () => send($, flow.original, 'sent-original'), 'o'),
      cancelButton(),
    ),
    flow.note === null ? null : <Text color={MUTED}>{flow.note}</Text>,
    <Text> </Text>,
    changes.length === 0 ? null : heading('What changed'),
    ...changes.slice(0, 8).map(change => (
      <Text color={TEXT}>
        <Text color={MUTED}>{'· '}</Text>
        {change}
      </Text>
    )),
    changes.length === 0 ? null : <Text> </Text>,
    isWide ? (
      <Box flexDirection="row" columnGap={1} width={cols}>
        {card('Your prompt', flow.original, half)}
        {card('Enhanced', rewrite, half, true)}
      </Box>
    ) : (
      <Box flexDirection="column" width={cols}>
        {card('Your prompt', flow.original, cols)}
        {card('Enhanced', rewrite, cols, true)}
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
