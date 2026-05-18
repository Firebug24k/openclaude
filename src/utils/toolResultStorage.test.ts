import { expect, test } from 'bun:test'

import { createUserMessage } from './messages.ts'
import {
  applyToolResultReplacementsToMessages,
  createContentReplacementState,
  measureContentReplacementState,
  measureToolUseResultRetention,
  scrubAgedToolUseResults,
  trimContentReplacementState,
} from './toolResultStorage.ts'

function toolResultMsg(id: string, payload: string) {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: payload,
        is_error: false,
      },
    ],
    toolUseResult: { stdout: payload, stderr: '' },
  })
}

test('applyToolResultReplacementsToMessages replaces matching tool results and preserves unrelated messages', () => {
  const unrelated = createUserMessage({ content: 'keep me' })
  const oversizedResult = createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'very large tool output',
        is_error: false,
      },
    ],
    toolUseResult: {
      stdout: 'very large tool output',
      stderr: '',
    },
  })
  const messages = [unrelated, oversizedResult]
  const replacement =
    '<persisted-output>\nOutput too large. Preview\n</persisted-output>'

  const next = applyToolResultReplacementsToMessages(
    messages,
    new Map([['tool-1', replacement]]),
  )

  expect(next).not.toBe(messages)
  expect(next[0]).toBe(unrelated)
  expect(next[1]).not.toBe(oversizedResult)
  expect((next[1]!.message.content as Array<{ content: string }>)[0]!.content).toBe(
    replacement,
  )
  expect(next[1]!.toolUseResult).toBeUndefined()
})

test('applyToolResultReplacementsToMessages is idempotent when messages are already hydrated', () => {
  const hydrated = createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: '<persisted-output>\nPreview\n</persisted-output>',
        is_error: false,
      },
    ],
  })
  const messages = [hydrated]

  const next = applyToolResultReplacementsToMessages(
    messages,
    new Map([['tool-1', '<persisted-output>\nPreview\n</persisted-output>']]),
  )

  expect(next).toBe(messages)
})

test('scrubAgedToolUseResults keeps the N most recent toolUseResult payloads', () => {
  const messages = [
    toolResultMsg('a', 'aaa'),
    toolResultMsg('b', 'bbb'),
    toolResultMsg('c', 'ccc'),
    toolResultMsg('d', 'ddd'),
    toolResultMsg('e', 'eee'),
  ]
  const next = scrubAgedToolUseResults(messages, 2)
  // Two most recent kept, three oldest scrubbed.
  expect(next[0]!.toolUseResult).toBeUndefined()
  expect(next[1]!.toolUseResult).toBeUndefined()
  expect(next[2]!.toolUseResult).toBeUndefined()
  expect(next[3]!.toolUseResult).toEqual({ stdout: 'ddd', stderr: '' })
  expect(next[4]!.toolUseResult).toEqual({ stdout: 'eee', stderr: '' })
})

test('scrubAgedToolUseResults preserves wire content blocks (only nulls structured payload)', () => {
  const messages = [toolResultMsg('a', 'aaa'), toolResultMsg('b', 'bbb')]
  const next = scrubAgedToolUseResults(messages, 1)
  // Old tool_result block content is untouched — the model still sees it.
  expect(
    (next[0]!.message.content as Array<{ type: string; content: string }>)[0]!
      .content,
  ).toBe('aaa')
  expect(next[0]!.toolUseResult).toBeUndefined()
})

test('scrubAgedToolUseResults is a no-op when count <= keepRecent', () => {
  const messages = [toolResultMsg('a', 'aaa'), toolResultMsg('b', 'bbb')]
  const next = scrubAgedToolUseResults(messages, 5)
  expect(next).toBe(messages)
})

test('scrubAgedToolUseResults skips user messages without toolUseResult when counting', () => {
  const plain = createUserMessage({ content: 'hello' })
  const messages = [
    toolResultMsg('a', 'aaa'),
    plain,
    toolResultMsg('b', 'bbb'),
    toolResultMsg('c', 'ccc'),
  ]
  const next = scrubAgedToolUseResults(messages, 2)
  expect(next[0]!.toolUseResult).toBeUndefined() // scrubbed
  expect(next[1]).toBe(plain) // unrelated user message untouched
  expect(next[2]!.toolUseResult).toEqual({ stdout: 'bbb', stderr: '' })
  expect(next[3]!.toolUseResult).toEqual({ stdout: 'ccc', stderr: '' })
})

test('scrubAgedToolUseResults with keepRecent=0 scrubs all', () => {
  const messages = [toolResultMsg('a', 'aaa'), toolResultMsg('b', 'bbb')]
  const next = scrubAgedToolUseResults(messages, 0)
  expect(next[0]!.toolUseResult).toBeUndefined()
  expect(next[1]!.toolUseResult).toBeUndefined()
})

test('scrubAgedToolUseResults with negative keepRecent returns input', () => {
  const messages = [toolResultMsg('a', 'aaa')]
  const next = scrubAgedToolUseResults(messages, -1)
  expect(next).toBe(messages)
})

test('scrubAgedToolUseResults on empty array is a no-op', () => {
  const next = scrubAgedToolUseResults([], 5)
  expect(next).toEqual([])
})

test('measureToolUseResultRetention counts and ranks payloads by size', () => {
  const messages = [
    toolResultMsg('a', 'x'.repeat(10)),
    toolResultMsg('b', 'x'.repeat(1000)),
    toolResultMsg('c', 'x'.repeat(100)),
  ]
  const stats = measureToolUseResultRetention(messages)
  expect(stats.totalMessages).toBe(3)
  expect(stats.userMessages).toBe(3)
  expect(stats.withToolUseResult).toBe(3)
  expect(stats.approxBytes).toBeGreaterThan(1100)
  expect(stats.topPayloads).toHaveLength(3)
  // Top-1 should be the biggest payload (index 1, 'b')
  expect(stats.topPayloads[0]!.toolUseId).toBe('b')
  expect(stats.topPayloads[0]!.size).toBeGreaterThan(stats.topPayloads[1]!.size)
})

test('measureToolUseResultRetention ignores scrubbed (undefined) payloads', () => {
  const messages = [toolResultMsg('a', 'aaa')]
  const scrubbed = scrubAgedToolUseResults(messages, 0)
  const stats = measureToolUseResultRetention(scrubbed)
  expect(stats.withToolUseResult).toBe(0)
  expect(stats.approxBytes).toBe(0)
})

test('trimContentReplacementState evicts oldest entries when over cap', () => {
  const state = createContentReplacementState()
  for (let i = 0; i < 10; i++) {
    state.seenIds.add(`id-${i}`)
    state.replacements.set(`id-${i}`, `r-${i}`)
  }
  const evicted = trimContentReplacementState(state, 3)
  expect(evicted).toBe(7)
  expect(state.seenIds.size).toBe(3)
  expect(state.replacements.size).toBe(3)
  // Oldest were evicted, newest survive
  expect(state.replacements.has('id-9')).toBe(true)
  expect(state.replacements.has('id-0')).toBe(false)
})

test('trimContentReplacementState is a no-op when within cap', () => {
  const state = createContentReplacementState()
  state.seenIds.add('id-1')
  state.replacements.set('id-1', 'r-1')
  expect(trimContentReplacementState(state, 10)).toBe(0)
  expect(state.seenIds.size).toBe(1)
})

test('measureContentReplacementState reports sizes', () => {
  const state = createContentReplacementState()
  state.seenIds.add('a')
  state.seenIds.add('b')
  state.replacements.set('a', 'hello')
  const stats = measureContentReplacementState(state)
  expect(stats.seenIds).toBe(2)
  expect(stats.replacements).toBe(1)
  expect(stats.approxReplacementBytes).toBe(5)
})

test('measureContentReplacementState handles undefined state', () => {
  const stats = measureContentReplacementState(undefined)
  expect(stats).toEqual({ seenIds: 0, replacements: 0, approxReplacementBytes: 0 })
})
