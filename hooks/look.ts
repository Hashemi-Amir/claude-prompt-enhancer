import type { Flow, HistoryEntry } from '../types'

// One accent for frames, titles and the current step. Everything else is plain or dim, so it follows the terminal's theme.
export const ACCENT = '#ffa116'
export const PASS = '#2cbb5d'
export const FAIL = '#ef4743'

export const STEPS = ['Your prompt', 'Questions', 'Rewrite', 'Review'] as const
export const SIDE_BY_SIDE_MIN = 100

export const fit = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`)
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

export function stepIndex(flow: Flow): number {
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

export function when(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const OUTCOME: Record<HistoryEntry['outcome'], { label: string; mark: string }> = {
  'sent-rewrite': { label: 'sent rewrite', mark: '✓' },
  'sent-original': { label: 'sent original', mark: '↩' },
  cancelled: { label: 'cancelled', mark: '·' },
}
