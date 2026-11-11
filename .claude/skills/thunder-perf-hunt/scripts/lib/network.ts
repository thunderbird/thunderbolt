/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Page, Request } from 'playwright'
import type { NetworkSample } from './types'

/** Observe completed/failed requests; stop before context teardown can create intentional aborts. */
export const collectNetwork = (page: Page) => {
  const samples: NetworkSample[] = []
  const pending: Promise<void>[] = []
  const errors: unknown[] = []
  const finished = (request: Request) => {
    const read = async () => {
      try {
        const response = await request.response()
        if (!response) {
          throw new Error(`Finished request has no response: ${request.url()}`)
        }
        const size = await request.sizes()
        samples.push({
          url: request.url().slice(0, 300),
          method: request.method(),
          status: response.status(),
          resourceType: request.resourceType(),
          transferSizeBytes: size.responseBodySize + size.responseHeadersSize,
          durationMs: Math.max(0, request.timing().responseEnd),
          renderBlocking: ['script', 'stylesheet'].includes(request.resourceType()),
        })
      } catch (error) {
        errors.push(error)
      }
    }
    pending.push(read())
  }
  const failed = (request: Request) => {
    const timing = request.timing()
    samples.push({
      url: request.url().slice(0, 300),
      method: request.method(),
      status: 0,
      resourceType: request.resourceType(),
      transferSizeBytes: 0,
      durationMs: Math.max(
        0,
        timing.responseEnd < 0 && timing.startTime > 0 ? Date.now() - timing.startTime : timing.responseEnd,
      ),
      renderBlocking: ['script', 'stylesheet'].includes(request.resourceType()),
    })
  }
  const dispose = () => {
    page.off('requestfinished', finished)
    page.off('requestfailed', failed)
  }
  page.on('requestfinished', finished)
  page.on('requestfailed', failed)
  return {
    dispose,
    finish: async () => {
      dispose()
      await Promise.all(pending)
      if (errors.length) {
        throw new AggregateError(errors, 'Network measurement failed')
      }
      return samples
    },
  }
}
