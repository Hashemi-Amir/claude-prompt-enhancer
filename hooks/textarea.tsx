import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

// The terminal's own Input keeps a long line on one scrolling row; this text area wraps at spaces, so every part of a prompt is in view.

export type TextAreaProps = { id: string; text: string; rows: number; columns: number }

type State = { id: string; text: string; at: number; top: number; goal: number | null }

/** One drawn row: where it starts and ends in the text, and whether a newline (or the end) closes it. */
export type Row = { start: number; end: number; isBreak: boolean }

/** Breaks the text into rows of at most `width` characters, at a space where one fits. */
export function layout(text: string, width: number): Row[] {
  const w = Math.max(1, width)
  const rows: Row[] = []
  let offset = 0

  for (const line of text.split('\n')) {
    let s = 0

    if (line.length === 0) rows.push({ start: offset, end: offset, isBreak: true })

    while (s < line.length) {
      let e = Math.min(line.length, s + w)

      if (e < line.length) {
        // The space stays at the end of its row, so the next row starts on a word.
        const space = line.lastIndexOf(' ', e)
        if (space >= s) e = space + 1
      }

      rows.push({ start: offset + s, end: offset + e, isBreak: e === line.length })
      s = e
    }

    offset += line.length + 1
  }

  return rows
}

/** The row and column the cursor at `at` is drawn on. A wrapped row's end belongs to the row below it. */
export function locate(rows: Row[], at: number): { row: number; col: number } {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    if (at >= r.start && (at < r.end || (r.isBreak && at === r.end))) return { row: i, col: at - r.start }
  }

  const last = rows.length - 1

  return { row: last, col: at - (rows[last]?.start ?? 0) }
}

/** The text index at a row and column, held inside that row. */
export function indexAt(rows: Row[], row: number, col: number): number {
  const r = rows[Math.max(0, Math.min(rows.length - 1, row))]
  if (r === undefined) return 0
  // A wrapped row's last index is the next row's first, so stop one short of it.
  const max = r.isBreak ? r.end : Math.max(r.start, r.end - 1)

  return Math.min(max, r.start + Math.max(0, col))
}

const wordLeft = (text: string, at: number) => {
  let i = at
  while (i > 0 && /\s/.test(text[i - 1]!)) i--
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--
  return i
}

const wordRight = (text: string, at: number) => {
  let i = at
  while (i < text.length && /\s/.test(text[i]!)) i++
  while (i < text.length && !/\s/.test(text[i]!)) i++
  return i
}

// Keeps what a paste carries and drops what a terminal sends as control.
const cleanInput = (raw: string): string | null => {
  const unwrapped = raw.replace(/\x1b\[200~|\x1b\[201~/g, '')
  if (unwrapped.includes('\x1b')) return null
  const text = unwrapped.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')

  return text === '' ? null : text
}

// A lone lowercase word is a key name this text area does not handle (escape, insert, f5), never typed text.
const isKeyName = (key: string) => /^[a-z][a-z0-9]{1,15}$/.test(key)

const widthOf = (props: TextAreaProps) => Math.max(4, props.columns - 1)

/** Scrolls just enough to keep the cursor's row in view. */
const follow = (s: State, props: TextAreaProps): State => {
  const { row } = locate(layout(s.text, widthOf(props)), s.at)
  const top = Math.min(row, Math.max(s.top, row - props.rows + 1))

  return { ...s, top: Math.max(0, top) }
}

const fresh = (props: TextAreaProps): State => follow({ id: props.id, text: props.text, at: props.text.length, top: 0, goal: null }, props)

function onKey(surface: ClientSurface<State>, props: TextAreaProps, ev: ClientKeyEvent): void {
  const s = surface.state
  if (s === undefined) return
  const rows = layout(s.text, widthOf(props))
  const here = locate(rows, s.at)
  const isWord = ev.ctrl === true || ev.meta === true
  let next = null as State | null

  const edit = (text: string, at: number) => {
    next = { ...s, text, at, goal: null }
    surface.post({ id: s.id, text })
  }
  const go = (at: number, goal: number | null = null) => {
    next = { ...s, at: Math.max(0, Math.min(s.text.length, at)), goal }
  }

  switch (ev.key) {
    case 'return':
      if (ev.shift || ev.meta) edit(s.text.slice(0, s.at) + '\n' + s.text.slice(s.at), s.at + 1)
      else surface.post({ id: s.id, text: s.text, action: 'run' })
      break
    case 'backspace': {
      const from = isWord ? wordLeft(s.text, s.at) : Math.max(0, s.at - 1)
      if (from < s.at) edit(s.text.slice(0, from) + s.text.slice(s.at), from)
      break
    }
    case 'delete': {
      const to = isWord ? wordRight(s.text, s.at) : Math.min(s.text.length, s.at + 1)
      if (to > s.at) edit(s.text.slice(0, s.at) + s.text.slice(to), s.at)
      break
    }
    case 'left':
      go(isWord ? wordLeft(s.text, s.at) : s.at - 1)
      break
    case 'right':
      go(isWord ? wordRight(s.text, s.at) : s.at + 1)
      break
    case 'up':
    case 'down': {
      const goal = s.goal ?? here.col
      const row = here.row + (ev.key === 'up' ? -1 : 1)
      if (row < 0) go(0)
      else if (row >= rows.length) go(s.text.length)
      else go(indexAt(rows, row, goal), goal)
      break
    }
    case 'home':
      go(isWord ? 0 : (rows[here.row]?.start ?? 0))
      break
    case 'end':
      go(isWord ? s.text.length : indexAt(rows, here.row, Number.MAX_SAFE_INTEGER))
      break
    default: {
      if (ev.ctrl || isKeyName(ev.key)) break
      const typed = cleanInput(ev.key)
      if (typed !== null) edit(s.text.slice(0, s.at) + typed + s.text.slice(s.at), s.at + typed.length)
    }
  }

  if (next !== null) surface.setState(follow(next, props))
}

function onPointer(surface: ClientSurface<State>, props: TextAreaProps, ev: ClientPointerEvent): void {
  const s = surface.state
  if (s === undefined || ev.type !== 'down') return
  const rows = layout(s.text, widthOf(props))

  surface.setState({ ...s, at: indexAt(rows, s.top + ev.y, ev.x), goal: null })
}

let latest: TextAreaProps = { id: '', text: '', rows: 3, columns: 40 }

const TextArea: ClientModule<TextAreaProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  latest = props
  let s = surface.state

  if (s === undefined) {
    surface.onKey(ev => onKey(surface, latest, ev))
    surface.onPointer(ev => onPointer(surface, latest, ev))
  }

  // A new prompt to edit starts over, the cursor after its last word.
  if (s === undefined || s.id !== props.id) {
    s = fresh(props)
    surface.setState(s)
  }

  const rows = layout(s.text, widthOf(props))
  const cursor = locate(rows, s.at)

  return (
    <Box flexDirection="column" height={props.rows}>
      {rows.slice(s.top, s.top + props.rows).map((r, i) => {
        const text = s.text.slice(r.start, r.end)

        if (s.top + i !== cursor.row) return <Text key={`r${s.top + i}`}>{text === '' ? ' ' : text}</Text>

        return (
          <Text key={`r${s.top + i}`}>
            {text.slice(0, cursor.col)}
            <Text inverse>{text[cursor.col] ?? ' '}</Text>
            {text.slice(cursor.col + 1)}
          </Text>
        )
      })}
    </Box>
  )
}

export default TextArea
