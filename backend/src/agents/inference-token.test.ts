/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import { createTestSettings } from '@/test-utils/settings'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { SignJWT, decodeJwt } from 'jose'
import { mintAgentInferenceToken, verifyAgentInferenceToken } from './inference-token'

const secret = 'agent-inference-test-secret-at-least-32-chars'

describe('agent inference token', () => {
  let getSettingsSpy: ReturnType<typeof spyOn>

  beforeAll(() => {
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(
      createTestSettings({ agentInferenceJwtSecret: secret }),
    )
  })

  afterAll(() => {
    getSettingsSpy.mockRestore()
  })

  it('round-trips a minted token back to its claims', async () => {
    const token = await mintAgentInferenceToken({
      userId: 'user-1',
      deploymentId: 'openclaw:abc',
      expiresInSeconds: 3600,
    })

    const claims = await verifyAgentInferenceToken(token)
    expect(claims).toEqual({ userId: 'user-1', deploymentId: 'openclaw:abc' })
  })

  it('mints a non-expiring token when expiresInSeconds is null', async () => {
    const token = await mintAgentInferenceToken({
      userId: 'user-1',
      deploymentId: 'openclaw:abc',
      expiresInSeconds: null,
    })

    expect(decodeJwt(token).exp).toBeUndefined()
    expect(await verifyAgentInferenceToken(token)).toEqual({ userId: 'user-1', deploymentId: 'openclaw:abc' })
  })

  it('returns null for an expired token', async () => {
    const token = await mintAgentInferenceToken({
      userId: 'user-1',
      deploymentId: 'openclaw:abc',
      expiresInSeconds: -10,
    })

    expect(await verifyAgentInferenceToken(token)).toBeNull()
  })

  it('returns null for a token with the wrong audience', async () => {
    const token = await new SignJWT({ deploymentId: 'openclaw:abc' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setAudience('powersync')
      .setIssuedAt()
      .sign(new TextEncoder().encode(secret))

    expect(await verifyAgentInferenceToken(token)).toBeNull()
  })

  it('returns null for a token signed with a different secret', async () => {
    const token = await new SignJWT({ deploymentId: 'openclaw:abc' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setAudience('agent-inference')
      .setIssuedAt()
      .sign(new TextEncoder().encode('some-other-secret-at-least-32-chars-long'))

    expect(await verifyAgentInferenceToken(token)).toBeNull()
  })

  it('returns null for garbage input', async () => {
    expect(await verifyAgentInferenceToken('not-a-jwt')).toBeNull()
    expect(await verifyAgentInferenceToken('')).toBeNull()
  })

  it('throws when the secret is not configured', () => {
    getSettingsSpy.mockReturnValueOnce(createTestSettings({ agentInferenceJwtSecret: '' }))
    expect(
      mintAgentInferenceToken({ userId: 'user-1', deploymentId: 'openclaw:abc', expiresInSeconds: null }),
    ).rejects.toThrow('agentInferenceJwtSecret is not configured')
  })
})
