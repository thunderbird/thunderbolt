/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isMinimalModeHiddenPath, minimalModeHiddenEntityTypes } from './registry'

describe('minimalModeHiddenEntityTypes', () => {
  it('lists exactly the entities whose result route is a Settings or Projects page', () => {
    expect([...minimalModeHiddenEntityTypes].sort()).toEqual(['agent', 'device', 'mcp', 'model', 'project', 'skill'])
  })
})

describe('isMinimalModeHiddenPath', () => {
  it('matches Settings and Projects routes only', () => {
    expect(['/settings/models', '/projects', '/projects/abc'].map(isMinimalModeHiddenPath)).toEqual([true, true, true])
    expect(['/chats/new', '/tasks', '/projectsx'].map(isMinimalModeHiddenPath)).toEqual([false, false, false])
  })
})
