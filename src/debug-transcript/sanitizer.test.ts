/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { sanitizeDebugTranscriptSecrets } from './sanitizer'
import type { JsonValue } from './types'

describe('sanitizeDebugTranscriptSecrets', () => {
  it('redacts secret-bearing keys throughout nested objects and arrays', () => {
    const input: JsonValue = {
      headers: {
        Authorization: 'Bearer provider-token',
        'x-api-key': 'sk-secret-key',
        cookie: 'session=secret',
      },
      nested: [
        { API_KEY: 'another-secret', displayName: 'Ítalo' },
        { refresh_token: 'refresh-secret', password: 'hunter2' },
      ],
    }

    expect(sanitizeDebugTranscriptSecrets(input)).toEqual({
      headers: {
        Authorization: '[redacted]',
        'x-api-key': '[redacted]',
        cookie: '[redacted]',
      },
      nested: [
        { API_KEY: '[redacted]', displayName: 'Ítalo' },
        { refresh_token: '[redacted]', password: '[redacted]' },
      ],
    })
  })

  it('returns a new tree without mutating the input', () => {
    const input = { nested: { secret: 'keep-the-original' }, list: [{ value: 'safe' }] } satisfies JsonValue

    const output = sanitizeDebugTranscriptSecrets(input)

    expect(output).not.toBe(input)
    expect(output.nested).not.toBe(input.nested)
    expect(output.list).not.toBe(input.list)
    expect(input.nested.secret).toBe('keep-the-original')
  })

  it('redacts JWTs, bearer tokens, and provider keys inside mixed-content strings', () => {
    const input = {
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-value',
      bearer: 'Request failed while using Bearer abcdefghijklmnopqrstuvwxyz123456; retry later.',
      openAi: 'upstream returned sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      anthropic: 'key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
      github: 'credential ghp_abcdefghijklmnopqrstuvwxyz123456 was rejected',
    } satisfies JsonValue

    expect(sanitizeDebugTranscriptSecrets(input)).toEqual({
      jwt: '[redacted]',
      bearer: 'Request failed while using [redacted]; retry later.',
      openAi: 'upstream returned [redacted]',
      anthropic: 'key=[redacted]',
      github: 'credential [redacted] was rejected',
    })
  })

  it('preserves identified content and ordinary prose', () => {
    const input = {
      email: 'imenezes@thunderbird.net',
      name: 'Ítalo Menezes',
      prose: 'The token budget is short, but no token value appears here.',
      short: 'sk-short',
      sentence: 'Authorization is required before continuing.',
    } satisfies JsonValue

    expect(sanitizeDebugTranscriptSecrets(input)).toEqual(input)
  })

  it('redacts credentials in URL query parameters and userinfo', () => {
    const input = {
      query: 'https://api.example.test/items?limit=10&access_token=secret-value&signature=signed-value#section',
      userinfo: 'postgres://database-user:database-password@db.example.test/app',
    } satisfies JsonValue

    expect(sanitizeDebugTranscriptSecrets(input)).toEqual({
      query: 'https://api.example.test/items?limit=10&access_token=[redacted]&signature=[redacted]#section',
      userinfo: 'postgres://[redacted]:[redacted]@db.example.test/app',
    })
  })

  it('preserves token counters while redacting token credential keys', () => {
    const input = {
      maxTokens: 4096,
      max_tokens: 4096,
      tokenCount: 200,
      tokensUsed: 150,
      budgetTokens: 1000,
      token: 'secret',
      accessToken: 'secret',
      auth_token: 'secret',
      refreshToken: 'secret',
      apiToken: 'opaque-api-value',
      sessionToken: 'opaque-session-value',
      csrfToken: 'opaque-csrf-value',
      nextToken: 'opaque-page-cursor',
    } satisfies JsonValue

    expect(sanitizeDebugTranscriptSecrets(input)).toEqual({
      maxTokens: 4096,
      max_tokens: 4096,
      tokenCount: 200,
      tokensUsed: 150,
      budgetTokens: 1000,
      token: '[redacted]',
      accessToken: '[redacted]',
      auth_token: '[redacted]',
      refreshToken: '[redacted]',
      apiToken: '[redacted]',
      sessionToken: '[redacted]',
      csrfToken: '[redacted]',
      nextToken: '[redacted]',
    })
  })
})
