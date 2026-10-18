export type Question = { question: string; options: string[] }

/** One question's answer: the chosen or typed text, `null` when skipped, absent while open. */
export type Answer = string | null

export type Rewrite = { prompt: string; changes: string[] }

export type Step = 'compose' | 'reading' | 'questions' | 'rewriting' | 'review' | 'editing' | 'error'

export type Flow = {
  id: string
  original: string
  source: 'command' | 'auto' | 'history'
  step: Step
  questions: Question[]
  answers: (Answer | undefined)[]
  /** The question whose "Other" field is open, if any. */
  otherOpen: number | null
  rewrite: Rewrite | null
  flags: string[]
  error: { message: string; retry: 'questions' | 'rewrite' } | null
  /** The model call this flow waits on; a reload that finds it set starts the call again. */
  pending: { kind: 'questions' | 'rewrite'; callId: string } | null
  note: string | null
  /** The rewrite as edited so far, while the edit step is open. */
  draft: string | null
}

export type HistoryEntry = {
  id: string
  at: number
  original: string
  questions: Question[]
  answers: { question: string; answer: string }[]
  rewrite: Rewrite
  flags: string[]
  outcome: 'sent-rewrite' | 'sent-original' | 'cancelled'
}

export type View = 'flow' | 'history' | 'settings'

export type Model = 'haiku' | 'sonnet' | 'opus'

/** Which model asks the questions and which writes the rewrite. */
export type Models = { questions: Model; rewrite: Model }

declare module 'claude-code' {
  interface PluginState {
    'prompt-enhancer': {
      flow: Flow | null
      view: View
      history: HistoryEntry[]
      auto: boolean
      /** The view the settings screen goes back to on Done. */
      settingsReturn: View
    }
  }
}
