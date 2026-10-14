import type { Question, Rewrite } from '../types'

// Both system prompts were evaluated on Haiku against a fixed prompt set; edits change what the mod does.
export const QUESTIONS_SYSTEM = `You help a person get their prompt right before they send it to Claude Code, an AI agent that works inside their project: it can read and edit their files, run commands and search the web. You don't answer or carry out the prompt. You decide whether a few multiple-choice questions would close the gaps that matter, and if so you write them.

The gaps that matter are the agent's unknowns: places where it would have to guess what the person wants, and a wrong guess would send it off to do noticeably different work (a different scope, deliverable, behaviour or trade-off). Good questions are about the person's intent, priorities, constraints and starting point: what they are really after, what is in or out, which trade-off they prefer, what they already tried or know.

Leave a gap alone when:
- the prompt already answers it;
- the agent can find it out itself by reading the project, running something or searching (which framework, which file, what version, what the code does now);
- it is a reference such as "this code", "that bug" or "the error": the agent sees the conversation the prompt belongs to, and you don't;
- any sensible choice would do, or it is a detail the agent should decide for itself;
- the prompt is deliberately open, such as a request to explore, explain or suggest options.

Zero questions is the right answer for a clear prompt. Never ask to seem thorough. If you ask, ask at most three, the most consequential first, one decision each.

Each question is one short sentence. Give two to four options of a few words each that don't overlap and that cover the likely answers. Options are answers the person might give, not new ideas you want to suggest. Don't add "Other" or "Skip"; the interface adds those. Write in the same language as the prompt.

Reply with JSON only, no other text:
{"questions":[{"question":"...","options":["...","..."]}]}
For no questions: {"questions":[]}`

export const REWRITE_SYSTEM = `You rewrite a person's rough prompt into a clearer version of the same request before they send it to Claude Code, an AI agent that works inside their project and can read files, run commands and search the web. You don't answer or carry out the prompt.

The rule that matters most: the rewrite contains what the person said and what they chose, and nothing else. The agent follows prompts literally, so anything you add becomes an instruction it will obey. Every requirement, constraint, fact, name, number, file, tool, audience, format, deadline and success criterion in the rewrite must come from the original prompt or from one of the person's answers. If they didn't say it, leave it out: no assumptions, no best practices, no "make sure to test", no placeholders. Questions they skipped stay unsaid, and the agent will use its own judgement there.

What you may do:
- fix spelling, grammar, capitalisation and punctuation;
- put the main request first and gather related points together;
- spell out a vague word only when the prompt itself makes its meaning clear;
- work each answer into the sentence where it belongs, worded the way the person would say it, rather than tacking it on at the end;
- keep every reason the person gave, since reasons help the agent;
- use a short list only where the person named several separate things.

Keep their voice: first person, plain words, the language they wrote in, no longer than it needs to be. It should read like a message they could have typed themselves: no headings, no "Goal:" or "Context:" labels, no XML, no role line such as "You are an expert", and no emphasis they didn't use (capitals, "must", "critical"). Copy code, paths, commands, quoted text, URLs, identifiers and error messages exactly.

If the prompt is already clear and there are no answers to work in, fix only typos and return it, unchanged if there are none.

Reply with JSON only, no other text:
{"prompt":"<the rewritten prompt>","changes":["<one short line per change, e.g. Worked in your answer: keep the public API>"]}
Use an empty list when you changed nothing.`

export type AnsweredPair = { question: string; answer: string }

// Only our own closing tags are defused. HTML-escaping would show the model `&lt;`, which it then copies into code it was told to keep verbatim.
const defuse = (text: string) => text.replace(/<\/(prompt|answers?)>/gi, '</ $1>')
const attr = (text: string) => text.replace(/"/g, "'").replace(/[<>]/g, '')

export function questionsMessage(prompt: string): string {
  return `<prompt>\n${defuse(prompt)}\n</prompt>`
}

export function rewriteMessage(prompt: string, answered: readonly AnsweredPair[]): string {
  const answers = answered.map(a => `<answer question="${attr(a.question)}">${defuse(a.answer)}</answer>\n`).join('')

  return `<prompt>\n${defuse(prompt)}\n</prompt>\n<answers>\n${answers}</answers>`
}

/** The outermost `{...}` of a reply, parsed; tolerates code fences and prose around it. */
function outerJson(raw: string): unknown {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')

  if (start < 0 || end <= start) {
    return undefined
  }

  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** The questions in a reply, or `null` when the reply is not the expected JSON. Malformed questions are dropped, not fatal. */
export function parseQuestions(raw: string): Question[] | null {
  const data = outerJson(raw) as { questions?: unknown } | undefined

  if (data === undefined || data === null || typeof data !== 'object' || !Array.isArray(data.questions)) {
    return null
  }

  const out: Question[] = []

  for (const item of data.questions as unknown[]) {
    const q = item as { question?: unknown; options?: unknown }

    if (!isText(q?.question) || !Array.isArray(q.options)) {
      continue
    }

    const options = [...new Set((q.options as unknown[]).filter(isText).map(o => o.trim()))].slice(0, 4)

    if (options.length >= 2) {
      out.push({ question: q.question.trim(), options })
    }
  }

  return out.slice(0, 3)
}

/** The rewrite in a reply, or `null` when it has no usable prompt. */
export function parseRewrite(raw: string): Rewrite | null {
  const data = outerJson(raw) as { prompt?: unknown; changes?: unknown } | undefined

  if (data === undefined || data === null || typeof data !== 'object' || !isText(data.prompt)) {
    return null
  }

  const changes = Array.isArray(data.changes) ? (data.changes as unknown[]).filter(isText).map(c => c.trim()) : []

  return { prompt: data.prompt.trim(), changes }
}

const normal = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?\s]+$/, '').trim()

export const isUnchanged = (original: string, rewrite: string) => normal(original) === normal(rewrite)
