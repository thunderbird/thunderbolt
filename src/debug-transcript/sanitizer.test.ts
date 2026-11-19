/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { sanitizeDebugTranscriptSecrets, sanitizeDebugTranscriptText } from './sanitizer'
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
        { API_KEY: 'another-secret', displayName: 'Avery Example' },
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
        { API_KEY: '[redacted]', displayName: 'Avery Example' },
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
      email: 'avery@example.com',
      name: 'Avery Example',
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
      oauth:
        'https://app.example.test/callback?code=auth-code&state=xyz&client_secret=cs&id_token=idt&refresh_token=rt&assertion=jwt',
    } satisfies JsonValue

    expect(sanitizeDebugTranscriptSecrets(input)).toEqual({
      query: 'https://api.example.test/items?limit=10&access_token=[redacted]&signature=[redacted]#section',
      userinfo: 'postgres://[redacted]:[redacted]@db.example.test/app',
      oauth:
        'https://app.example.test/callback?code=[redacted]&state=xyz&client_secret=[redacted]&id_token=[redacted]&refresh_token=[redacted]&assertion=[redacted]',
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

  it('redacts private keys, passphrases, credentials, and pwd-style keys', () => {
    const input: JsonValue = {
      privateKey: '-----BEGIN PRIVATE KEY-----\nMIIEvQ==\n-----END PRIVATE KEY-----',
      private_key: 'raw',
      passphrase: 'correct horse battery staple',
      credentials: { user: 'avery' },
      DB_PWD: 'hunter2',
      displayName: 'Avery Example',
    }

    expect(sanitizeDebugTranscriptSecrets(input)).toEqual({
      privateKey: '[redacted]',
      private_key: '[redacted]',
      passphrase: '[redacted]',
      credentials: '[redacted]',
      DB_PWD: '[redacted]',
      displayName: 'Avery Example',
    })
  })
})

describe('free-text credential encodings', () => {
  it.each([
    'PRIVATE KEY',
    'RSA PRIVATE KEY',
    'EC PRIVATE KEY',
    'DSA PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
    'ENCRYPTED PRIVATE KEY',
  ])('redacts %s blocks with real or escaped line breaks', (label) => {
    const secret = crypto.randomUUID()
    for (const newline of ['\n', '\r\n', String.raw`\n`]) {
      const input = `Before -----BEGIN ${label}-----${newline}${secret}${newline}-----END ${label}----- after`
      expect(sanitizeDebugTranscriptText(input) === 'Before [redacted] after').toBe(true)
    }
  })

  it('redacts an unterminated private key through the end of the text', () => {
    const secret = crypto.randomUUID()
    const output = sanitizeDebugTranscriptText(`Before -----BEGIN PRIVATE KEY-----\n${secret}`)
    expect(output === 'Before [redacted]').toBe(true)
  })

  it.each([
    'aws_secret_access_key',
    'AWS_SECRET_ACCESS_KEY',
    'awsSecretAccessKey',
    'client_secret',
    'clientSecret',
    'client-secret',
  ])('redacts labeled %s assignments embedded in text and JSON strings', (label) => {
    const secret = crypto.randomUUID()
    const inputs = [
      `Before ${label}=${secret}; after`,
      `Before "${label}": "${secret}", after`,
      `Before '${label}' = '${secret}'; after`,
      `Before ${label}: ${secret} after`,
      String.raw`Before \"${label}\": \"${secret}\", after`,
    ]
    for (const input of inputs) {
      const output = sanitizeDebugTranscriptText(input)
      expect(output.includes(secret)).toBe(false)
      expect(output.includes('[redacted]')).toBe(true)
      expect(output.startsWith('Before ')).toBe(true)
      expect(output.endsWith('after')).toBe(true)
      expect(sanitizeDebugTranscriptText(output)).toBe(output)
    }
  })

  it('keeps ordinary prose, long words, public PEM blocks and mentions of labels', () => {
    const input =
      'A client_secret is required. aws_secret_access_key documentation. ' +
      'ordinary'.repeat(100) +
      '\n-----BEGIN PUBLIC KEY-----\npublic material\n-----END PUBLIC KEY-----'
    expect(sanitizeDebugTranscriptText(input)).toBe(input)
  })
})

it('redacts escaped quote suffixes, template literals and truncated assignments', () => {
  const secret = crypto.randomUUID()
  const inputs = [
    JSON.stringify(JSON.stringify({ client_secret: `prefix${String.fromCharCode(92, 34)}${secret}` })),
    `client_secret=\`${secret}\``,
    `client_secret="${secret}`,
    'client_secret=' + String.fromCharCode(92, 34) + String.fromCharCode(92).repeat(36) + secret,
    `client_secret=sk-proj-${'a'.repeat(20)}!${secret}`,
  ]
  for (const input of inputs) {
    expect(sanitizeDebugTranscriptText(input).includes(secret)).toBe(false)
  }
})

it('preserves URL fragments after labeled query credentials', () => {
  expect(sanitizeDebugTranscriptText('https://example.test/?client_secret=value#section')).toBe(
    'https://example.test/?client_secret=[redacted]#section',
  )
})

it.each(['#', '&', ',', ';', '[', ']', '{', '}', '<', '>'])(
  'redacts leading and embedded %s in bare client secrets',
  (punctuation) => {
    const secret = crypto.randomUUID()
    for (const value of [`${punctuation}${secret}`, `prefix${punctuation}${secret}`]) {
      const output = sanitizeDebugTranscriptText(`Before client_secret=${value} after`)
      expect(output.includes(secret)).toBe(false)
      expect(output).toBe('Before client_secret=[redacted] after')
    }
  },
)

it('preserves query separators for URL-style credential parameters', () => {
  expect(sanitizeDebugTranscriptText('?client_secret=opaque&state=visible#section')).toBe(
    '?client_secret=[redacted]&state=visible#section',
  )
  expect(sanitizeDebugTranscriptText('https://example.test/?aws_secret_access_key=opaque&state=visible#section')).toBe(
    'https://example.test/?aws_secret_access_key=[redacted]&state=visible#section',
  )
})

it.each(['Client Secret', 'AWS Secret Access Key', 'client  secret', 'AWS Secret Access  Key'])(
  'redacts the spaced %s label without hiding prose mentions',
  (label) => {
    const secret = crypto.randomUUID()
    expect(sanitizeDebugTranscriptText(`${label}: ${secret}`).includes(secret)).toBe(false)
    const prose = `The ${label} is required before continuing.`
    expect(sanitizeDebugTranscriptText(prose)).toBe(prose)
  },
)
