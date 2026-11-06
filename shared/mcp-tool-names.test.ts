/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { sanitizeToolPrefix } from './mcp-tool-names'

describe('sanitizeToolPrefix', () => {
  const cases: Array<[string | null | undefined, string]> = [
    ['Render', 'render'],
    ['render.com', 'render_com'],
    ['My Server', 'my_server'],
    ['api.github.com', 'api_github_com'],
    ['  spaced  ', 'spaced'],
    ['UPPER_snake', 'upper_snake'],
    ['weird!!!name', 'weird_name'],
    ['---', 'mcp'],
    ['', 'mcp'],
    [null, 'mcp'],
    [undefined, 'mcp'],
    ['localhost-3000', 'localhost_3000'],
  ]

  it.each(cases)('sanitizes %p → %p', (input, expected) => {
    expect(sanitizeToolPrefix(input)).toBe(expected)
  })
})
