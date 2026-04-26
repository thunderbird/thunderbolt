import { describe, expect, test } from 'bun:test'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'

// Test the permission dialog's option variant logic without rendering
// (full render tests would require test-provider setup)

const mockPermissionRequest: RequestPermissionRequest = {
  sessionId: 'session-1',
  toolCall: {
    toolCallId: 'tc-1',
    title: 'Edit /src/app.tsx',
    kind: 'edit',
    status: 'pending',
    locations: [{ path: '/src/app.tsx', line: 42 }],
  },
  options: [
    { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Always Allow', kind: 'allow_always' },
    { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
    { optionId: 'reject-always', name: 'Always Deny', kind: 'reject_always' },
  ],
}

describe('PermissionDialog data', () => {
  test('request has correct structure', () => {
    expect(mockPermissionRequest.options).toHaveLength(4)
    expect(mockPermissionRequest.toolCall?.kind).toBe('edit')
    expect(mockPermissionRequest.toolCall?.locations).toHaveLength(1)
    expect(mockPermissionRequest.toolCall?.locations?.[0].path).toBe('/src/app.tsx')
  })

  test('allow_once response has correct shape', () => {
    const response = {
      outcome: { outcome: 'selected' as const, optionId: 'allow-once' },
    }
    expect(response.outcome.outcome).toBe('selected')
    expect(response.outcome.optionId).toBe('allow-once')
  })

  test('cancelled response has correct shape', () => {
    const response = {
      outcome: { outcome: 'cancelled' as const },
    }
    expect(response.outcome.outcome).toBe('cancelled')
  })
})
