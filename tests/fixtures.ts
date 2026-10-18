import type { On, PromptSubmitInput, RenderElement, RenderInput, RenderNode, RenderSurface, SessionStartInput } from 'claude-code'

export const NAME = 'prompt-enhancer'

export const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

export const pane = (surface: RenderSurface = 'terminal', bodyColumns = 120): RenderInput<'Pane'> => ({
  component: 'Pane',
  surface,
  requestId: NAME,
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: {
    title: 'Prompt Enhancer',
    isFocused: true,
    bodyColumns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 44 },
    view: {},
  },
})

export const command = (args = '') => ({
  command: 'enhance',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 180 },
})

/** A submission as the person's Enter at an idle prompt; `extra` overrides. */
export const typed = (text: string, extra: Partial<PromptSubmitInput> = {}): PromptSubmitInput => ({
  text,
  wait: false,
  origin: { kind: 'composer' },
  ...extra,
})

export type World = {
  opened: string[]
  closed: string[]
  fills: string[]
  /** What reached the bottom of prompt.submit: the prompts that were actually sent. */
  sent: { text: string; origin: string }[]
  statuses: (string | undefined)[]
  logs: string[]
  copies: string[]
  commands: string[]
  /** Every model request, in order. */
  calls: { model: string; system: string; prompt: string }[]
  /** Replies the fake model gives, in order; a string is a text reply, `null` an API error. */
  replies: (string | null)[]
  unplaced: boolean
  /** Every /config row written, in order. */
  configs: { key: string; value: unknown }[]
  /** When set, /config refuses every write with this reason. */
  configDeny: string | null
  toasts: string[]
  /** The prompt box's draft, as Claude Code holds it. */
  box: string
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

/** The engine beneath the plugin, in memory. */
export function worldOf(on: On): World {
  const world: World = { opened: [], closed: [], fills: [], sent: [], statuses: [], logs: [], copies: [], commands: [], calls: [], replies: [], unplaced: false, box: '', configs: [], configDeny: null, toasts: [] }

  on('command.register', ($, e) => {
    world.commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.open', ($, e) => {
    world.opened.push(e.id)

    return { value: world.unplaced ? { isPlaced: false, reason: 'no surface' } : { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    world.closed.push(e.id)

    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    world.statuses.push(e.text)

    return { value: undefined }
  })
  on('config.set', ($, e) => {
    if (world.configDeny !== null) return { deny: world.configDeny }
    world.configs.push({ key: e.key, value: e.value })

    return { value: e.value }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    world.logs.push(e.text)

    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    world.copies.push(e.text)

    return { value: { isCopied: true } } as never
  })
  on('prompt.read', () => ({ value: { text: world.box, cursor: world.box.length } }))
  on('prompt.fill', ($, e) => {
    world.fills.push(e.text)
    world.box = e.text

    return { isFilled: true } as never
  })
  on('model.complete', ($, e) => {
    world.calls.push({ model: e.model, system: e.system ?? '', prompt: e.prompt })
    const reply = world.replies.shift()

    if (reply === undefined || reply === null) {
      return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE } } as never
    }

    return { value: { isAnswered: true, text: reply, usage: USAGE } } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => {
    world.sent.push({ text: e.text, origin: e.origin.kind })

    return { text: e.text }
  })

  return world
}

/** Every string a drawn tree holds, in drawing order. */
export function stringsOf(node: RenderNode | RenderElement | null | undefined): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return []
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return [String(node)]
  }

  const props = (node as { props?: Record<string, unknown> }).props
  const own: string[] = []

  if (node.type === 'Button' && typeof props?.label === 'string') own.push(props.label)
  if (node.type === 'Input' && typeof props?.value === 'string') own.push(props.value)

  const children = (node as { children?: readonly RenderNode[] }).children ?? []

  return [...own, ...children.flatMap(child => stringsOf(child))]
}

export const textOf = (node: RenderNode | RenderElement | null | undefined) => stringsOf(node).join('')

/** The keys of every element of `type` in a drawn tree. */
export function keysOf(node: RenderNode | RenderElement | null | undefined, type: string): string[] {
  if (node === null || node === undefined || typeof node !== 'object') {
    return []
  }

  const props = (node as { props?: Record<string, unknown> }).props
  const own = node.type === type && typeof props?.key === 'string' ? [props.key] : []
  const children = (node as { children?: readonly RenderNode[] }).children ?? []

  return [...own, ...children.flatMap(child => keysOf(child, type))]
}
