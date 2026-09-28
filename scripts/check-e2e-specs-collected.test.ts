/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { findUncollectedSpecs } from './check-e2e-specs-collected'

describe('findUncollectedSpecs', () => {
  it('reports each uncollected spec while accepting both configs and normalized paths', () => {
    expect(
      findUncollectedSpecs(
        ['e2e/oidc-login.spec.ts', './e2e/preview-smoke.spec.ts', 'e2e/nested/missing.spec.ts', 'e2e/another.spec.ts'],
        [resolve('e2e/oidc-login.spec.ts'), 'e2e/oidc-login.spec.ts', 'e2e/nested/../preview-smoke.spec.ts'],
      ),
    ).toEqual(['e2e/nested/missing.spec.ts', 'e2e/another.spec.ts'])
    expect(findUncollectedSpecs([], [])).toEqual([])
  })
})
