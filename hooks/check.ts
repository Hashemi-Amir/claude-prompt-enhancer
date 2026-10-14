// The "Not from you" net: specifics in the rewrite that never appear in what the person typed or picked.
// Deliberately cheap and conservative; it warns, it never blocks.

const MAX_FLAGS = 8
const PRONOUNS = new Set(['i', "i'm", "i've", "i'll", "i'd"])

const trimPunct = (token: string) => token.replace(/^[("'`[{<“‘]+|[)"'`\]}>”’.,;:!?]+$/g, '')

function candidates(rewrite: string): string[] {
  const found: string[] = []

  for (const m of rewrite.matchAll(/https?:\/\/[^\s)"'`]+/g)) found.push(m[0])
  for (const m of rewrite.matchAll(/`([^`]+)`/g)) found.push(m[1] ?? '')
  for (const m of rewrite.matchAll(/["“]([^"“”]{2,80})["”]/g)) found.push(m[1] ?? '')
  for (const m of rewrite.matchAll(/\[[^\]\n]{1,80}\]/g)) found.push(m[0])
  for (const m of rewrite.matchAll(/\d+(?:[-.,:/]\d+)*/g)) found.push(m[0])

  // Bracketed spans were taken whole above; their words would only repeat them.
  const tokens = rewrite.replace(/\[[^\]\n]{1,80}\]/g, ' ').split(/\s+/).filter(Boolean)

  tokens.forEach((raw, i) => {
    const token = trimPunct(raw)

    if (token === '' || /^https?:/.test(token)) {
      return
    }

    // Paths, file names and identifiers: a slash, an extension, inner capitals, underscores or digits inside a word.
    const isTechnical =
      token.includes('/') ||
      /\.[a-z0-9]{1,6}$/i.test(token) ||
      /[a-z][A-Z]/.test(token) ||
      /\w_\w/.test(token) ||
      /[A-Za-z]\d|\d[A-Za-z]/.test(token)

    // Proper nouns, Latin script only: a capital that does not open a sentence.
    const previous = tokens[i - 1]
    const opensSentence = previous === undefined || /[.!?:]["')\]]?$/.test(previous)
    const isName = /^[A-Z][a-zA-Z'-]+$/.test(token) && !opensSentence && !PRONOUNS.has(token.toLowerCase())

    if (isTechnical || isName) {
      found.push(token)
    }
  })

  return found
}

/** Specific items in `rewrite` that appear nowhere in `sources` (case-insensitive). */
export function notFromYou(rewrite: string, sources: readonly string[]): string[] {
  const corpus = sources.join('\n').toLowerCase()
  const seen = new Set<string>()
  const flags: string[] = []

  for (const item of candidates(rewrite)) {
    const value = item.trim()
    const key = value.toLowerCase()

    if (value === '' || seen.has(key)) {
      continue
    }

    seen.add(key)

    if (!corpus.includes(key)) {
      flags.push(value)
    }

    if (flags.length >= MAX_FLAGS) {
      break
    }
  }

  return flags
}
