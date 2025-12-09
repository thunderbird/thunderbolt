import { describe, expect, test } from 'bun:test'
import {
  detectsToolRefusal,
  extractTextFromMessages,
  hasToolCalls,
  isFinalStep,
  nudgeMessages,
  shouldRetry,
  shouldShowPreventiveNudge,
} from './step-logic'

describe('isFinalStep', () => {
  test('returns true when on the last step', () => {
    expect(isFinalStep(19, 20)).toBe(true)
  })

  test('returns true when past the threshold', () => {
    expect(isFinalStep(20, 20)).toBe(true)
  })

  test('returns false when not yet at final step', () => {
    expect(isFinalStep(18, 20)).toBe(false)
  })

  test('returns false on first step', () => {
    expect(isFinalStep(0, 20)).toBe(false)
  })

  test('handles edge case of maxSteps = 1', () => {
    expect(isFinalStep(0, 1)).toBe(true)
  })
})

describe('shouldShowPreventiveNudge', () => {
  const createSteps = (toolCallCount: number, otherCount = 0) => [
    ...Array(toolCallCount).fill({ finishReason: 'tool-calls' }),
    ...Array(otherCount).fill({ finishReason: 'stop' }),
  ]

  test('returns true when tool calls reach threshold', () => {
    expect(shouldShowPreventiveNudge(createSteps(6))).toBe(true)
  })

  test('returns true when tool calls exceed threshold', () => {
    expect(shouldShowPreventiveNudge(createSteps(10))).toBe(true)
  })

  test('returns false when below threshold', () => {
    expect(shouldShowPreventiveNudge(createSteps(5))).toBe(false)
  })

  test('returns false with empty steps', () => {
    expect(shouldShowPreventiveNudge([])).toBe(false)
  })

  test('only counts tool-calls finish reason', () => {
    const mixedSteps = createSteps(3, 5) // 3 tool-calls, 5 stop
    expect(shouldShowPreventiveNudge(mixedSteps)).toBe(false)
  })

  test('respects custom threshold', () => {
    expect(shouldShowPreventiveNudge(createSteps(3), 3)).toBe(true)
    expect(shouldShowPreventiveNudge(createSteps(2), 3)).toBe(false)
  })
})

describe('extractTextFromMessages', () => {
  test('extracts text from string content', () => {
    const messages = [{ role: 'assistant', content: 'Hello world' }]
    expect(extractTextFromMessages(messages)).toBe('Hello world')
  })

  test('extracts text from array content', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
      },
    ]
    expect(extractTextFromMessages(messages)).toBe('Hello world')
  })

  test('ignores non-text content types', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool-call', toolName: 'search' },
        ],
      },
    ]
    expect(extractTextFromMessages(messages)).toBe('Hello')
  })

  test('ignores user messages', () => {
    const messages = [
      { role: 'user', content: 'User text' },
      { role: 'assistant', content: 'Assistant text' },
    ]
    expect(extractTextFromMessages(messages)).toBe('Assistant text')
  })

  test('concatenates multiple assistant messages', () => {
    const messages = [
      { role: 'assistant', content: 'First ' },
      { role: 'user', content: 'ignored' },
      { role: 'assistant', content: 'Second' },
    ]
    expect(extractTextFromMessages(messages)).toBe('First Second')
  })

  test('returns empty string for empty messages', () => {
    expect(extractTextFromMessages([])).toBe('')
  })

  test('handles missing content property', () => {
    const messages = [{ role: 'assistant' }]
    expect(extractTextFromMessages(messages)).toBe('')
  })
})

describe('hasToolCalls', () => {
  test('returns true when tool-call exists', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolName: 'search' }],
      },
    ]
    expect(hasToolCalls(messages)).toBe(true)
  })

  test('returns false with only text content', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]
    expect(hasToolCalls(messages)).toBe(false)
  })

  test('returns false for user messages with tool-call type', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'tool-call' }],
      },
    ]
    expect(hasToolCalls(messages)).toBe(false)
  })

  test('returns false for string content', () => {
    const messages = [{ role: 'assistant', content: 'Hello' }]
    expect(hasToolCalls(messages)).toBe(false)
  })

  test('returns false for empty messages', () => {
    expect(hasToolCalls([])).toBe(false)
  })

  test('finds tool-call among mixed content', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me search' },
          { type: 'tool-call', toolName: 'search' },
        ],
      },
    ]
    expect(hasToolCalls(messages)).toBe(true)
  })
})

describe('shouldRetry', () => {
  test('returns true for empty text with tool calls and attempts remaining', () => {
    expect(shouldRetry('', true, 1, 2)).toBe(true)
  })

  test('returns true for whitespace-only text', () => {
    expect(shouldRetry('   \n\t  ', true, 1, 2)).toBe(true)
  })

  test('returns false when text is present', () => {
    expect(shouldRetry('Hello', true, 1, 2)).toBe(false)
  })

  test('returns false when no tool calls were made', () => {
    expect(shouldRetry('', false, 1, 2)).toBe(false)
  })

  test('returns false when max attempts reached', () => {
    expect(shouldRetry('', true, 2, 2)).toBe(false)
  })

  test('returns false when past max attempts', () => {
    expect(shouldRetry('', true, 3, 2)).toBe(false)
  })

  test('all conditions must be met', () => {
    // Missing any single condition should return false
    expect(shouldRetry('text', true, 1, 2)).toBe(false) // has text
    expect(shouldRetry('', false, 1, 2)).toBe(false) // no tool calls
    expect(shouldRetry('', true, 2, 2)).toBe(false) // no attempts left
  })
})

describe('nudgeMessages', () => {
  test('finalStep message is defined and non-empty', () => {
    expect(nudgeMessages.finalStep).toBeTruthy()
    expect(nudgeMessages.finalStep.length).toBeGreaterThan(0)
  })

  test('preventive message is defined and non-empty', () => {
    expect(nudgeMessages.preventive).toBeTruthy()
    expect(nudgeMessages.preventive.length).toBeGreaterThan(0)
  })

  test('retry message is defined and non-empty', () => {
    expect(nudgeMessages.retry).toBeTruthy()
    expect(nudgeMessages.retry.length).toBeGreaterThan(0)
  })

  test('toolRefusal message is defined and non-empty', () => {
    expect(nudgeMessages.toolRefusal).toBeTruthy()
    expect(nudgeMessages.toolRefusal.length).toBeGreaterThan(0)
  })
})

describe('detectsToolRefusal', () => {
  describe('generic patterns (always checked)', () => {
    test('detects "not connected to" pattern', () => {
      expect(detectsToolRefusal("I'm not connected to your account.")).toBe(true)
    })

    test('detects "not currently connected" pattern', () => {
      expect(detectsToolRefusal("I'm not currently connected to your account.")).toBe(true)
    })

    test('detects "share the file with me" pattern', () => {
      expect(detectsToolRefusal('Please share the file with me directly.')).toBe(true)
    })

    test('is case insensitive', () => {
      expect(detectsToolRefusal("I'M NOT CONNECTED TO your account.")).toBe(true)
    })
  })

  describe('Google-specific patterns', () => {
    test('detects Google refusal when Google is enabled', () => {
      expect(detectsToolRefusal("I can't access your Google Drive.", { google: true })).toBe(true)
      expect(detectsToolRefusal('I cannot access your Gmail.', { google: true })).toBe(true)
    })

    test('ignores Google refusal when Google is NOT enabled', () => {
      // Model legitimately can't access Google - don't trigger nudge
      expect(detectsToolRefusal("I can't access your Google Drive.", { google: false })).toBe(false)
      expect(detectsToolRefusal("I can't access your Google Drive.", {})).toBe(false)
    })
  })

  describe('Microsoft-specific patterns', () => {
    test('detects Microsoft refusal when Microsoft is enabled', () => {
      expect(detectsToolRefusal("I can't access your OneDrive.", { microsoft: true })).toBe(true)
      expect(detectsToolRefusal('I cannot access your Outlook.', { microsoft: true })).toBe(true)
    })

    test('ignores Microsoft refusal when Microsoft is NOT enabled', () => {
      // Model legitimately can't access Microsoft - don't trigger nudge
      expect(detectsToolRefusal("I can't access your OneDrive.", { microsoft: false })).toBe(false)
      expect(detectsToolRefusal("I can't access your OneDrive.", {})).toBe(false)
    })
  })

  describe('mixed scenarios', () => {
    test('detects correct integration when both are enabled', () => {
      const both = { google: true, microsoft: true }
      expect(detectsToolRefusal("I can't access your Google Drive.", both)).toBe(true)
      expect(detectsToolRefusal("I can't access your OneDrive.", both)).toBe(true)
    })

    test('only detects enabled integration', () => {
      expect(detectsToolRefusal("I can't access your Google Drive.", { google: true, microsoft: false })).toBe(true)
      expect(detectsToolRefusal("I can't access your OneDrive.", { google: true, microsoft: false })).toBe(false)
    })
  })

  describe('false positives prevention', () => {
    test('returns false for legitimate tool error responses', () => {
      const enabled = { google: true, microsoft: true }
      // These are legitimate responses after a tool was tried and failed
      expect(detectsToolRefusal('The file requires permission to view.', enabled)).toBe(false)
      expect(detectsToolRefusal('Access denied - you may not have permission.', enabled)).toBe(false)
      expect(detectsToolRefusal("I can't extract text from this PDF format.", enabled)).toBe(false)
    })

    test('returns false for normal responses', () => {
      expect(detectsToolRefusal('Here is the summary of your document.')).toBe(false)
      expect(detectsToolRefusal('I found the following information.')).toBe(false)
      expect(detectsToolRefusal('The weather in San Francisco is sunny.')).toBe(false)
    })

    test('returns false for empty string', () => {
      expect(detectsToolRefusal('')).toBe(false)
    })
  })
})
