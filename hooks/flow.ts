import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderSurface } from 'claude-code'

import type { Flow, HistoryEntry, Question, Rewrite, View } from '../types'
import { notFromYou } from './check'
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

type $ = EngineInterface

export const PLUGIN = 'prompt-enhancer'
export const PANE = 'prompt-enhancer'
export const TITLE = 'Prompt Enhancer'
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

export function getFlow($: $): Promise<Flow | null> {
  return read($, flowAtom)
}

export function getView($: $): Promise<View> {
  return read($, viewAtom)
}

export function getHistory($: $): Promise<HistoryEntry[]> {
  return read($, historyAtom)
}

export function getAuto($: $): Promise<boolean> {
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
export async function restore($: $): Promise<boolean> {
  const isAuto = (await load($, 'auto')) === true
  const stored = await load($, 'history')

  await update($, autoAtom, () => isAuto)
  await update($, historyAtom, () => (Array.isArray(stored) ? (stored as HistoryEntry[]) : []))

  return isAuto
}

export async function openPane($: $): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, rows: 24 })

  return opened.isPlaced
}

export function setFlow($: $, fn: (flow: Flow | null) => Flow | null): Promise<Flow | null> {
  return update($, flowAtom, fn)
}

/** Applies `fn` only while the flow is still the one, waiting on the same call, that `callId` belongs to. */
function settle($: $, flowId: string, callId: string, fn: (flow: Flow) => Flow): Promise<Flow | null> {
  return setFlow($, flow => (flow?.id === flowId && flow.pending?.callId === callId ? fn(flow) : flow))
}

// ---- starting -------------------------------------------------------------

export async function startCompose($: $): Promise<void> {
  await update($, viewAtom, () => 'flow' as View)
  await setFlow($, () => ({ ...blankFlow('', 'command'), step: 'compose' }))
}

export async function startFlow($: $, original: string, source: Flow['source'], model: string): Promise<void> {
  const flow = blankFlow(original, source)

  await update($, viewAtom, () => 'flow' as View)
  await setFlow($, () => ({ ...flow, pending: { kind: 'questions', callId: newId() } }))
  schedule($, model)
}

/** Runs the pending model call outside the dispatch that asked for it, so commands and presses answer at once. */
export function schedule($: $, model: string): void {
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

export const answeredPairs = (flow: Pick<Flow, 'questions' | 'answers'>): AnsweredPair[] =>
  flow.questions.flatMap((q, i) => {
    const answer = flow.answers[i]

    return typeof answer === 'string' && answer.trim() !== '' ? [{ question: q.question, answer: answer.trim() }] : []
  })

export async function runPending($: $, model: string): Promise<void> {
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

export async function answer($: $, index: number, value: string | null, model: string): Promise<void> {
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

export async function rewriteNow($: $, model: string): Promise<void> {
  await setFlow($, f =>
    f === null || (f.step !== 'questions' && f.step !== 'error')
      ? f
      : { ...f, step: 'rewriting', error: null, otherOpen: null, pending: { kind: 'rewrite', callId: newId() } },
  )
  schedule($, model)
}

export async function retry($: $, model: string): Promise<void> {
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
export async function clearBoxOf($: $, text: string): Promise<void> {
  const box = await $.prompt.read()

  if (text.trim() !== '' && box.text.trim() === text.trim()) {
    await $.prompt.fill({ text: '' })
  }
}

/** Claude Code puts a dropped prompt back in the box; once it has, take it out and hand the pane the keyboard. */
export function tidyAfterDrop($: $, text: string): void {
  $.clock.after(150, () => {
    clearBoxOf($, text)
      .then(() => openPane($))
      .catch(() => undefined)
  })
}

/** Sends `text` as the person's own prompt and closes the pane. */
export async function send($: $, text: string, outcome: HistoryEntry['outcome']): Promise<void> {
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
export async function cancel($: $, options: { isClosed: boolean }): Promise<void> {
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

export async function copy($: $, text: string, surface: RenderSurface): Promise<void> {
  const r = await $.ui.copy({ text, surface })

  await setFlow($, f => (f === null ? f : { ...f, note: r.isCopied ? 'Copied.' : 'Could not copy here.' }))
}

export async function openHistory($: $): Promise<void> {
  await update($, viewAtom, () => 'history' as View)
}

export async function reopen($: $, entry: HistoryEntry): Promise<void> {
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

export async function setAuto($: $, isOn: boolean): Promise<void> {
  await update($, autoAtom, () => isOn)
  await save($, 'auto', isOn)
  $.ui.status(isOn ? 'Prompt Enhancer: auto' : undefined)
}

export async function clearHistory($: $): Promise<void> {
  await update($, historyAtom, () => [])
  await save($, 'history', [])
}

export const isClear = (flow: Flow) => flow.rewrite !== null && isUnchanged(flow.original, flow.rewrite.prompt)
