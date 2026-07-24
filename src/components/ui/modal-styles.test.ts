/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { centeredModalSurfaceClass, modalCloseClass, modalOverlayClass } from './modal-styles'

describe('shared modal classes', () => {
  it('keeps overlay, hero surface, and close-control treatments centralized', () => {
    expect(modalOverlayClass).toContain('backdrop-blur-md')
    expect(centeredModalSurfaceClass).toContain('rounded-2xl')
    expect(modalCloseClass).toContain('rounded-full')
  })
})
