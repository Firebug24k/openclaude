import { expect, test } from 'bun:test'

import { createUserMessage } from './messages.ts'
import {
  applyToolResultReplacementsToMessages,
  scrubAgedToolUseResults,
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
