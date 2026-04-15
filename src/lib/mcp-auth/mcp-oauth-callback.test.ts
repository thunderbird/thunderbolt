import { describe, expect, it } from 'bun:test'
import { deliverMcpOAuthCode, failMcpOAuthCode, hasPendingMcpOAuth, waitForMcpOAuthCode } from './mcp-oauth-callback'

describe('mcp-oauth-callback bridge', () => {
  it('delivers authorization code to waiting consumer', async () => {
    const promise = waitForMcpOAuthCode()
    expect(hasPendingMcpOAuth()).toBe(true)

    deliverMcpOAuthCode('auth_code_123')
    expect(hasPendingMcpOAuth()).toBe(false)

    const code = await promise
    expect(code).toBe('auth_code_123')
  })

  it('rejects with error when OAuth fails', async () => {
    const promise = waitForMcpOAuthCode()
    failMcpOAuthCode('access_denied')

    expect(promise).rejects.toThrow('access_denied')
  })

  it('ignores deliverMcpOAuthCode when no pending flow', () => {
    // Should not throw
    deliverMcpOAuthCode('orphan_code')
    expect(hasPendingMcpOAuth()).toBe(false)
  })

  it('ignores failMcpOAuthCode when no pending flow', () => {
    failMcpOAuthCode('orphan_error')
    expect(hasPendingMcpOAuth()).toBe(false)
  })
})
