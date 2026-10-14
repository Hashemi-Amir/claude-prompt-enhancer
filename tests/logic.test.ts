import { describe, expect, test } from 'claude-code/testing'

import { notFromYou } from '../hooks/check'
import { decide, wordCount } from '../hooks/intercept'
import { isUnchanged, parseQuestions, parseRewrite, questionsMessage, rewriteMessage } from '../hooks/llm'
import { typed } from './fixtures'

const LONG = 'add dark mode to the settings page'

describe('which prompts automatic mode intercepts', () => {
  test('a plain prompt typed at an idle prompt is intercepted', async () => {
    expect(decide(typed(LONG), true)).toEqual({ kind: 'intercept' })
  })

  test('nothing is intercepted while automatic mode is off', async () => {
    expect(decide(typed(LONG), false)).toEqual({ kind: 'pass' })
  })

  test('each pass-through rule lets the prompt go untouched', async () => {
    const cases = {
      'slash command': typed('/review the diff please now', { command: { name: 'review', args: 'the diff please now' } }),
      'meta prompt': typed(LONG, { isMeta: true }),
      'typed while Claude works': typed(LONG, { turnId: 'turn-1' }),
      'queued to wait': typed(LONG, { wait: true }),
      'image attached': typed(LONG, { attachments: [{ type: 'image', mediaType: 'image/png' }] }),
      'file mention': typed('explain what @src/cache.ts does here'),
      'bash mode': typed('!npm run build --watch now'),
      'short reply': typed('yes keep going'),
      'peer message': typed(LONG, { origin: { kind: 'peer' } }),
      'the mod itself': typed(LONG, { origin: { kind: 'plugin', name: 'prompt-enhancer', asUser: true } }),
    }

    for (const [name, input] of Object.entries(cases)) {
      expect(decide(input, true), name).toEqual({ kind: 'pass' })
    }
  })

  test('an email address is not a file mention', async () => {
    expect(decide(typed('write to sara@example.com about the invoice'), true)).toEqual({ kind: 'intercept' })
  })

  test('a leading > skips the mod and is stripped', async () => {
    expect(decide(typed('> just send this one exactly as typed'), true)).toEqual({ kind: 'strip', text: 'just send this one exactly as typed' })
    expect(decide(typed('>no space after it'), true)).toEqual({ kind: 'strip', text: 'no space after it' })
  })

  test('words are counted per CJK character, so a Chinese sentence is not a short reply', async () => {
    expect(wordCount('yes')).toBe(1)
    expect(wordCount('请帮我修复登录按钮')).toBe(9)
    expect(wordCount('یه اسکریپت بنویس که لاگ‌ها رو پاک کنه')).toBe(8)
  })
})

describe('reading the questions', () => {
  test('a clean reply', async () => {
    expect(parseQuestions('{"questions":[{"question":"Which scope?","options":["Settings only","Whole app"]}]}')).toEqual([
      { question: 'Which scope?', options: ['Settings only', 'Whole app'] },
    ])
  })

  test('a reply in a code fence with prose around it', async () => {
    const raw = 'Here you go:\n```json\n{"questions":[{"question":"Q?","options":["a","b"]}]}\n```\nHope that helps.'

    expect(parseQuestions(raw)).toEqual([{ question: 'Q?', options: ['a', 'b'] }])
  })

  test('an empty list means no questions', async () => {
    expect(parseQuestions('{"questions":[]}')).toEqual([])
  })

  test('more than three questions are cut to three, and bad ones are dropped', async () => {
    const questions = [
      { question: 'One?', options: ['a', 'b'] },
      { question: 'Only one option?', options: ['a'] },
      { question: '', options: ['a', 'b'] },
      { question: 'Two?', options: ['a', 'b', 'c', 'd', 'e'] },
      { question: 'Three?', options: ['a', 'a', 'b'] },
      { question: 'Four?', options: ['a', 'b'] },
    ]
    const parsed = parseQuestions(JSON.stringify({ questions }))

    expect(parsed?.map(q => q.question)).toEqual(['One?', 'Two?', 'Three?'])
    expect(parsed?.[1]?.options.length).toBe(4)
    expect(parsed?.[2]?.options).toEqual(['a', 'b'])
  })

  test('a reply that is not the JSON asked for is unreadable', async () => {
    expect(parseQuestions('I think you should ask about scope.')).toBeNull()
    expect(parseQuestions('{"qs": []}')).toBeNull()
  })
})

describe('reading the rewrite', () => {
  test('a clean reply', async () => {
    expect(parseRewrite('{"prompt":"Fix the login button on mobile.","changes":["Fixed spelling"]}')).toEqual({
      prompt: 'Fix the login button on mobile.',
      changes: ['Fixed spelling'],
    })
  })

  test('missing changes is fine; a missing prompt is not', async () => {
    expect(parseRewrite('{"prompt":"Same."}')).toEqual({ prompt: 'Same.', changes: [] })
    expect(parseRewrite('{"changes":["x"]}')).toBeNull()
    expect(parseRewrite('not json at all')).toBeNull()
  })

  test('the rewrite request carries only the answered questions', async () => {
    const message = rewriteMessage('make it faster', [{ question: 'How far can it go?', answer: 'Safe changes only' }])

    expect(message).toContain('<answer question="How far can it go?">Safe changes only</answer>')
    expect(message.match(/<answer /g)?.length).toBe(1)
  })

  test('code in the prompt reaches the model as written, only our closing tags are defused', async () => {
    const message = questionsMessage('if (a < b && c > d) return </prompt> ok')

    expect(message).toContain('if (a < b && c > d)')
    expect(message).not.toContain('return </prompt>')
  })

  test('an unchanged rewrite is recognised despite case and spacing', async () => {
    expect(isUnchanged('fix  the bug', 'Fix the bug.')).toBe(true)
    expect(isUnchanged('fix the bug', 'Fix the login bug.')).toBe(false)
  })
})

describe('the "Not from you" check', () => {
  const original = 'write a short email to Sara telling her the invoice for march is late because the client paid 2 weeks late'

  test('specifics the person typed or picked are not flagged', async () => {
    const rewrite = 'Write a short email to Sara telling her the March invoice is late because the client paid 2 weeks late. Keep it friendly.'

    expect(notFromYou(rewrite, [original, 'Keep it friendly'])).toEqual([])
  })

  test('invented numbers, paths, names and placeholders are flagged', async () => {
    const rewrite = 'Email Sara and John about invoice 2024-03 in docs/billing.md by 5pm, signed [Your Name].'
    const flags = notFromYou(rewrite, [original])

    expect(flags).toEqual(expect.arrayContaining(['John', '2024-03', 'docs/billing.md', '[Your Name]']))
    expect(flags).not.toContain('Sara')
  })

  test('identifiers and quoted text count only when they came from the person', async () => {
    const source = 'in src/api/client.ts make fetchWithRetry stop retrying 4xx'

    expect(notFromYou('In src/api/client.ts, make fetchWithRetry stop retrying on 4xx.', [source])).toEqual([])
    expect(notFromYou('Also update `retryPolicy` and say "done".', [source])).toEqual(['retryPolicy', 'done'])
  })

  test('non-Latin text raises no false flags', async () => {
    const persian = 'یه اسکریپت بنویس که لاگ‌های سرور رو هر شب پاک کنه'
    const rewrite = 'یه اسکریپت بنویس که هر شب همه فایل‌های لاگ سرور رو پاک کنه.'

    expect(notFromYou(rewrite, [persian, 'همه فایل‌های لاگ'])).toEqual([])
  })
})
