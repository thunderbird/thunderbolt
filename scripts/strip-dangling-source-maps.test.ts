/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { stripDanglingSourceMapComment } from './strip-dangling-source-maps'

const script = 'var a = 1;\n'

describe('stripDanglingSourceMapComment', () => {
  it('strips a comment whose map is not in the bundle', () => {
    const source = `${script}//# sourceMappingURL=pptxgen.bundle.js.map\n`
    expect(stripDanglingSourceMapComment('assets/pptxgen.bundle-abc.js', source, new Set())).toBe(script)
  })

  it('keeps a comment whose map is in the bundle, resolved beside the script', () => {
    const source = `${script}//# sourceMappingURL=lib.js.map`
    const bundle = new Set(['assets/lib.js', 'assets/lib.js.map'])
    expect(stripDanglingSourceMapComment('assets/lib.js', source, bundle)).toBeNull()
  })

  it('keeps an inline data map', () => {
    const source = `${script}//# sourceMappingURL=data:application/json;base64,e30=`
    expect(stripDanglingSourceMapComment('assets/lib.js', source, new Set())).toBeNull()
  })

  it('leaves a script without a trailing comment alone', () => {
    expect(stripDanglingSourceMapComment('assets/lib.js', script, new Set())).toBeNull()
    expect(
      stripDanglingSourceMapComment('assets/lib.js', '//# sourceMappingURL=a.js.map\nvar a = 1;', new Set()),
    ).toBeNull()
  })
})
