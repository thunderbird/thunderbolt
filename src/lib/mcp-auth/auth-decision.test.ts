/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { decideTestConnectionResult, deriveOAuthCardDecision } from './auth-decision'

/** The exact transport error a no-auth 401 surfaces as: `StreamableHTTPError`
 *  carries the HTTP status on `code` (streamableHttp.js:364), rejected un-wrapped
 *  by `@ai-sdk/mcp` (index.js:1856). */
const error401 = () =>
  Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token"}'), {
    code: 401,
  })
const error500 = () => Object.assign(new Error('Streamable HTTP error: boom'), { code: 500 })

describe('decideTestConnectionResult (dialog precedence)', () => {
  it('credential supplied + 401 → token-rejected (static config wins, no Authorize)', () => {
    // Even if OAuth would be actionable, a supplied credential takes precedence.
    expect(
      decideTestConnectionResult({ hasCredential: true, error: error401(), oauthActionability: 'authorizable' }),
    ).toEqual({
      kind: 'token-rejected',
    })
  })

  it('empty credential + 401 + OAuth authorizable → needs-oauth (Add & Authorize)', () => {
    expect(
      decideTestConnectionResult({ hasCredential: false, error: error401(), oauthActionability: 'authorizable' }),
    ).toEqual({
      kind: 'needs-oauth',
    })
  })

  it('empty credential + 401 + OAuth advertised but not actionable → needs-token (supply a PAT)', () => {
    expect(
      decideTestConnectionResult({ hasCredential: false, error: error401(), oauthActionability: 'token-only' }),
    ).toEqual({
      kind: 'needs-token',
    })
  })

  it('empty credential + 401 + no OAuth discoverable → error (no supported auth)', () => {
    expect(decideTestConnectionResult({ hasCredential: false, error: error401(), oauthActionability: 'none' })).toEqual(
      {
        kind: 'error',
      },
    )
  })

  it('a non-401 error is always a plain connection error', () => {
    expect(
      decideTestConnectionResult({ hasCredential: false, error: error500(), oauthActionability: 'authorizable' }),
    ).toEqual({
      kind: 'error',
    })
  })
})

describe('deriveOAuthCardDecision (card precedence)', () => {
  it('connected + oauth creds → authorized', () => {
    expect(
      deriveOAuthCardDecision({ isConnected: true, credentialType: 'oauth', error: undefined, needsReauth: false }),
    ).toEqual({ phase: 'authorized' })
  })

  it('connected + bearer creds → none (no OAuth affordance)', () => {
    expect(
      deriveOAuthCardDecision({ isConnected: true, credentialType: 'bearer', error: undefined, needsReauth: false }),
    ).toEqual({ phase: 'none' })
  })

  it('bearer creds + 401 → none (rejected token shows the generic connection error — the conflation fix)', () => {
    expect(
      deriveOAuthCardDecision({ isConnected: false, credentialType: 'bearer', error: error401(), needsReauth: false }),
    ).toEqual({ phase: 'none' })
  })

  it('oauth creds + 401 → needs-auth (re-authorize)', () => {
    expect(
      deriveOAuthCardDecision({ isConnected: false, credentialType: 'oauth', error: error401(), needsReauth: false }),
    ).toEqual({ phase: 'needs-auth' })
  })

  it('no stored creds + 401 → needs-auth (OAuth-eligible by precedence)', () => {
    expect(
      deriveOAuthCardDecision({ isConnected: false, credentialType: 'none', error: error401(), needsReauth: false }),
    ).toEqual({ phase: 'needs-auth' })
  })

  it('oauth creds + needs-reauth (refresh failed) → needs-auth, regardless of error', () => {
    expect(
      deriveOAuthCardDecision({ isConnected: false, credentialType: 'oauth', error: undefined, needsReauth: true }),
    ).toEqual({ phase: 'needs-auth' })
  })

  it('bearer creds + needs-reauth → needs-auth (refresh-failed always re-auths)', () => {
    // needsReauth precedes the bearer-conflation rule: it only ever fires for an
    // OAuth token whose refresh failed, so re-authorization is correct.
    expect(
      deriveOAuthCardDecision({ isConnected: false, credentialType: 'bearer', error: undefined, needsReauth: true }),
    ).toEqual({ phase: 'needs-auth' })
  })

  it('no creds + non-401 error → none (plain connection error, not needs-auth)', () => {
    expect(
      deriveOAuthCardDecision({ isConnected: false, credentialType: 'none', error: error500(), needsReauth: false }),
    ).toEqual({ phase: 'none' })
  })
})
