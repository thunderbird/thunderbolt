/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, jest, spyOn } from 'bun:test'
import type { PostHog } from 'posthog-node'
import * as client from './client'

describe('captureInferenceError', () => {
  it('is a no-op when PostHog is unconfigured', () => {
    const configuredSpy = spyOn(client, 'isPostHogConfigured').mockReturnValue(false)
    const clientSpy = spyOn(client, 'getPostHogClient')

    client.captureInferenceError({
      provider: 'anthropic',
      status: 400,
      errorKind: 'bad_request',
      distinctId: 'user-1',
    })

    expect(clientSpy).not.toHaveBeenCalled()
    configuredSpy.mockRestore()
    clientSpy.mockRestore()
  })

  it('captures an inference_upstream_error event with body-free structured metadata', () => {
    const capture = jest.fn()
    const configuredSpy = spyOn(client, 'isPostHogConfigured').mockReturnValue(true)
    const clientSpy = spyOn(client, 'getPostHogClient').mockReturnValue({ capture } as unknown as PostHog)

    client.captureInferenceError({
      provider: 'anthropic',
      status: 400,
      distinctId: 'user-1',
      errorKind: 'context_length',
      model: 'opus-4.8',
      errorType: 'invalid_request_error',
      errorCode: 'context_length_exceeded',
      requestId: 'provider-request-123',
      phase: 'stream',
    })

    expect(capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'inference_upstream_error',
      properties: {
        provider: 'anthropic',
        status: 400,
        errorKind: 'context_length',
        model: 'opus-4.8',
        errorType: 'invalid_request_error',
        errorCode: 'context_length_exceeded',
        requestId: 'provider-request-123',
        phase: 'stream',
      },
    })
    configuredSpy.mockRestore()
    clientSpy.mockRestore()
  })
})
