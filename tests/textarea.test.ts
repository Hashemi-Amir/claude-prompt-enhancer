import { describe, expect, test } from 'claude-code/testing'

import { indexAt, layout, locate } from '../hooks/textarea'

describe('the edit text area wraps prose', () => {
  test('rows break at a space and keep every character', () => {
    const text = 'the quick brown fox jumps over the lazy dog'
    const rows = layout(text, 12)

    expect(rows.map(r => text.slice(r.start, r.end))).toEqual(['the quick ', 'brown fox ', 'jumps over ', 'the lazy dog'])
    expect(rows.every(r => r.end - r.start <= 12)).toBe(true)
  })

  test('a word longer than the row is cut, and newlines start new rows', () => {
    const text = 'abcdefghijkl\n\nend'
    const rows = layout(text, 5)

    expect(rows.map(r => text.slice(r.start, r.end))).toEqual(['abcde', 'fghij', 'kl', '', 'end'])
  })

  test('the cursor after the last word sits at the end of the last row', () => {
    const text = 'the quick brown fox'
    const rows = layout(text, 10)

    expect(locate(rows, text.length)).toEqual({ row: 1, col: 9 })
  })

  test('the end of a wrapped row belongs to the row below, and clicks stay inside a row', () => {
    const text = 'one two three'
    const rows = layout(text, 8)

    expect(locate(rows, rows[0]!.end)).toEqual({ row: 1, col: 0 })
    expect(indexAt(rows, 0, 99)).toBe(rows[0]!.end - 1)
    expect(indexAt(rows, 1, 99)).toBe(text.length)
  })
})
