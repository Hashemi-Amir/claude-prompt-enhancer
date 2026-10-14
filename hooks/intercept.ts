import type { PromptSubmitInput } from 'claude-code'

export type Decision =
  | { kind: 'pass' }
  | { kind: 'strip'; text: string }
  | { kind: 'intercept' }

const MIN_WORDS = 4
const CJK = /[぀-ヿ㐀-鿿가-힯]/g

/** Words, counting each CJK character as one, since those scripts don't separate words with spaces. */
export function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .reduce((n, token) => n + Math.max(1, token.match(CJK)?.length ?? 0), 0)
}

export const hasMention = (text: string) => /(^|\s)@[^\s@]/.test(text)

/** What automatic mode does with one submission. Only the person's own Enter is ever intercepted, which is also what stops the mod's own sends from looping back. */
export function decide(e: PromptSubmitInput, isAuto: boolean): Decision {
  if (!isAuto || e.origin.kind !== 'composer' || e.command !== undefined || e.isMeta === true) {
    return { kind: 'pass' }
  }

  const text = e.text.trimStart()

  if (text.startsWith('>')) {
    return { kind: 'strip', text: text.replace(/^>\s?/, '') }
  }

  const isBusy = e.turnId !== undefined || e.wait
  const hasAttachments = (e.attachments?.length ?? 0) > 0

  if (isBusy || hasAttachments || hasMention(text) || text.startsWith('!') || wordCount(text) < MIN_WORDS) {
    return { kind: 'pass' }
  }

  return { kind: 'intercept' }
}
