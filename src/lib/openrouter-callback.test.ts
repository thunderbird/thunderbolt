/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { readOpenRouterCallback } from './openrouter-callback'

const flowId = 'a'.repeat(43)

describe('OpenRouter callback parsing', () => {
  it('uses the same nonce validation for Tinfoil callbacks', () => {
    expect(
      readOpenRouterCallback(new URL(`https://app.test/oauth/tinfoil/${flowId}?code=code&state=${flowId}`)),
    ).toEqual({
      flowId,
      message: { type: 'openrouter-callback', state: flowId, code: 'code' },
    })
    expect(
      readOpenRouterCallback(new URL(`https://app.test/oauth/tinfoil/${flowId}?code=code&state=wrong`))?.message,
    ).toEqual({ type: 'openrouter-callback', state: flowId, error: 'invalid_response' })
  })
  it('relays a code only when its returned state matches the secret path nonce', () => {
    expect(
      readOpenRouterCallback(new URL(`https://app.test/oauth/openrouter/${flowId}?code=code&state=${flowId}`)),
    ).toEqual({
      flowId,
      message: { type: 'openrouter-callback', state: flowId, code: 'code' },
    })
  })

  it.each(['code=code&state=wrong', 'code=code', `state=${flowId}`, `code=%20&state=${flowId}`])(
    'never relays codes from invalid success callbacks: %s',
    (query) => {
      expect(readOpenRouterCallback(new URL(`https://app.test/oauth/openrouter/${flowId}?${query}`))).toEqual({
        flowId,
        message: { type: 'openrouter-callback', state: flowId, error: 'invalid_response' },
      })
    },
  )

  it('targets denial without returned state and removes arbitrary provider error text', () => {
    expect(
      readOpenRouterCallback(new URL(`https://app.test/oauth/openrouter/${flowId}?error_description=private-data`)),
    ).toEqual({
      flowId,
      message: { type: 'openrouter-callback', state: flowId, error: 'cancelled' },
    })
  })

  it.each([
    '/oauth/callback',
    '/oauth/openrouter/short',
    `/oauth/openrouter/${'a'.repeat(44)}`,
    `/oauth/openrouter/${flowId}/extra`,
  ])('does not open a channel for malformed callback paths: %s', (path) => {
    expect(readOpenRouterCallback(new URL(`https://app.test${path}?code=code&state=${flowId}`))).toBeNull()
  })
})

it('routes the fixed Tinfoil callback by validated OAuth state', () => {
  const state = 'a'.repeat(43)
  expect(readOpenRouterCallback(new URL(`https://app.test/oauth/tinfoil?code=code&state=${state}`))).toEqual({
    flowId: state,
    message: { type: 'openrouter-callback', state, code: 'code' },
  })
  expect(readOpenRouterCallback(new URL('https://app.test/oauth/tinfoil?code=secret'))).toBeNull()
})
