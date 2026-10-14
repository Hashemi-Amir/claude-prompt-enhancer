import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { Flow, HistoryEntry } from '../types'
import {
  answer,
  answeredPairs,
  cancel,
  copy,
  getFlow,
  getHistory,
  getView,
  isClear,
  reopen,
  retry,
  rewriteNow,
  send,
  setFlow,
  startFlow,
} from './flow'

const GOLD = '#F2C46D'
const LINE = '#262B33'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'
const GREEN = '#3DD68C'
const AMBER = '#E3B341'
const INK = '#0D1117'

const TITLE = 'PROMPT ENHANCER'
const STEPS = ['Your prompt', 'Questions', 'Rewrite', 'Review'] as const
const SIDE_BY_SIDE_MIN = 100

const fit = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`)
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

function stepIndex(flow: Flow): number {
  switch (flow.step) {
    case 'compose':
    case 'reading':
      return 0
    case 'questions':
      return 1
    case 'rewriting':
      return 2
    case 'error':
      return flow.error?.retry === 'rewrite' ? 2 : 1
    default:
      return 3
  }
}

function when(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const OUTCOME: Record<HistoryEntry['outcome'], string> = {
  'sent-rewrite': 'sent rewrite',
  'sent-original': 'sent original',
  cancelled: 'cancelled',
}

/** Draws the pane. Reads state only; every change happens in a handler. */
export async function renderPane($: EngineInterface, e: RenderInput<'Pane'>, model: string): Promise<RenderElement> {
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
        {TITLE}
      </Text>
      <Text>
        <Text color={GOLD}>{'━'.repeat(Math.min(TITLE.length, cols))}</Text>
        <Text color={LINE}>{'─'.repeat(Math.max(0, cols - TITLE.length))}</Text>
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
