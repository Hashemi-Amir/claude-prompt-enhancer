import type { Flow, HistoryEntry } from '../types'

export const GOLD = '#F2C46D'
export const LINE = '#262B33'
export const MUTED = '#7D8590'
export const TEXT = '#E6EDF3'
export const GREEN = '#3DD68C'
export const AMBER = '#E3B341'
export const INK = '#0D1117'

export const HEADING = 'PROMPT ENHANCER'
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

export const OUTCOME: Record<HistoryEntry['outcome'], string> = {
  'sent-rewrite': 'sent rewrite',
  'sent-original': 'sent original',
  cancelled: 'cancelled',
}
