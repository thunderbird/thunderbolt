/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { SandboxedHtmlFrame } from './sandboxed-html-frame'

describe('SandboxedHtmlFrame', () => {
  it('renders a script-sandboxed iframe whose srcdoc contains the html plus the harness', () => {
    const { container } = render(<SandboxedHtmlFrame html="<h1>Chart</h1>" title="My chart" />)
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe?.getAttribute('title')).toBe('My chart')
    const srcdoc = iframe?.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('<h1>Chart</h1>')
    expect(srcdoc).toContain('postMessage')
  })

  it('never grants same-origin access to the sandboxed content', () => {
    const { container } = render(<SandboxedHtmlFrame html="<p>x</p>" title="t" />)
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })
})
