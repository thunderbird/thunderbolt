/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { connectReducer, initialConnectState, type ConnectState } from './use-connect-provider'

describe('connectReducer', () => {
  it('OPEN seeds the dialog with the provider type, default base URL and scope', () => {
    const next = connectReducer(initialConnectState, {
      type: 'OPEN',
      providerType: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      scope: 'user',
    })
    expect(next.type).toBe('ollama')
    expect(next.baseUrl).toBe('http://localhost:11434/v1')
    expect(next.scope).toBe('user')
    expect(next.status).toBe('idle')
  })

  it('CLOSE resets to the initial state', () => {
    const open: ConnectState = {
      ...initialConnectState,
      type: 'openai',
      apiKey: 'sk-x',
      status: 'error',
      error: 'boom',
    }
    expect(connectReducer(open, { type: 'CLOSE' })).toEqual(initialConnectState)
  })

  it('field setters update only their slice', () => {
    const withKey = connectReducer(initialConnectState, { type: 'SET_API_KEY', apiKey: 'sk-1' })
    expect(withKey.apiKey).toBe('sk-1')
    const withUrl = connectReducer(withKey, { type: 'SET_BASE_URL', baseUrl: 'http://x' })
    expect(withUrl).toMatchObject({ apiKey: 'sk-1', baseUrl: 'http://x' })
  })

  it('START clears prior errors and marks connecting', () => {
    const errored: ConnectState = { ...initialConnectState, status: 'error', error: 'nope' }
    const next = connectReducer(errored, { type: 'START' })
    expect(next.status).toBe('connecting')
    expect(next.error).toBeNull()
  })

  it('SUCCESS and FAILURE record terminal status', () => {
    expect(connectReducer(initialConnectState, { type: 'SUCCESS' }).status).toBe('success')
    const failed = connectReducer(initialConnectState, { type: 'FAILURE', error: 'bad key' })
    expect(failed).toMatchObject({ status: 'error', error: 'bad key' })
  })
})
