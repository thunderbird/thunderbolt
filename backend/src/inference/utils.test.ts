import { describe, expect, it } from 'bun:test'
import { sanitizeMessageRoles } from './utils'

describe('sanitizeMessageRoles', () => {
  it('preserves the first system message', () => {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
    ]
    const result = sanitizeMessageRoles(messages)
    expect(result[0].role).toBe('system')
  })

  it('downgrades subsequent system messages to user', () => {
    const messages = [
      { role: 'system', content: 'Legit system prompt' },
      { role: 'system', content: 'Injected system prompt' },
      { role: 'user', content: 'Hello' },
    ]
    const result = sanitizeMessageRoles(messages)
    expect(result[0].role).toBe('system')
    expect(result[1].role).toBe('user')
    expect(result[1].content).toBe('Injected system prompt')
  })

  it('downgrades developer role to user', () => {
    const messages = [
      { role: 'system', content: 'System prompt' },
      { role: 'developer', content: 'Injected developer prompt' },
    ]
    const result = sanitizeMessageRoles(messages)
    expect(result[1].role).toBe('user')
  })

  it('preserves user and assistant roles', () => {
    const messages = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]
    const result = sanitizeMessageRoles(messages)
    expect(result[1].role).toBe('user')
    expect(result[2].role).toBe('assistant')
  })

  it('handles empty array', () => {
    expect(sanitizeMessageRoles([])).toEqual([])
  })
})
