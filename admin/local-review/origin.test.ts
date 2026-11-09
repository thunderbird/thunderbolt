/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { expect, it } from 'bun:test'
import { assertLocalReviewOrigin, localReviewOrigin } from './origin'

it('permits the dedicated admin development origin', () => {
  expect(() => assertLocalReviewOrigin(localReviewOrigin, true)).not.toThrow()
})

it.each([
  'http://localhost:1426',
  'http://[::1]:1426',
  'http://127.0.0.1:1420',
  'http://localhost:1424',
  'https://127.0.0.1:1426',
  'https://example.com',
])('rejects %s before demo settings can affect that origin', (origin) => {
  expect(() => assertLocalReviewOrigin(origin, true)).toThrow('dedicated development origin')
})

it('rejects production even on the dedicated origin', () => {
  expect(() => assertLocalReviewOrigin(localReviewOrigin, false)).toThrow('dedicated development origin')
})
