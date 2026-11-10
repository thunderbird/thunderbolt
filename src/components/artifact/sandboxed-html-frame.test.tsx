/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, render } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
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

  it('injects the offline CSP but no harness when scripts are disabled (streaming preview)', () => {
    const { container } = render(<SandboxedHtmlFrame html="<p>partial</p>" title="t" allowScripts={false} />)
    const iframe = container.querySelector('iframe')
    const srcdoc = iframe?.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('<p>partial</p>')
    expect(srcdoc).toContain('Content-Security-Policy') // preview is still offline
    expect(srcdoc).not.toContain('postMessage') // but no harness — scripts are off
    expect(iframe?.getAttribute('sandbox')).toBe('')
  })
  it('registers requests once per ready document and revokes them across reloads', async () => {
    type Request = (method: string, params: unknown) => Promise<unknown>
    const requests: (Request | null)[] = []
    const onRequestReady = mock((request: Request | null) => {
      requests.push(request)
    })
    const { container, rerender } = render(
      <SandboxedHtmlFrame html="<p>First</p>" title="Page" onRequestReady={onRequestReady} />,
    )
    const iframe = container.querySelector('iframe')!
    const nonce = /var NONCE = "([^"]+)"/.exec(iframe.getAttribute('srcdoc') ?? '')?.[1]
    expect(nonce).toBeTruthy()
    const ready = (artifactNonce = nonce) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: iframe.contentWindow,
          data: { artifactNonce, type: 'artifact-ready' },
        }),
      )
    act(() => {
      ready()
      ready()
    })
    expect(onRequestReady).toHaveBeenCalledTimes(1)
    const request = requests[0]!
    const pending = request('page/snapshot', {})
    rerender(<SandboxedHtmlFrame html="<p>Second</p>" title="Page" onRequestReady={onRequestReady} />)
    expect(requests.at(-1)).toBeNull()
    expect(await pending).toBeNull()
    await expect(request('page/snapshot', {})).rejects.toThrow('document changed')
    act(() => ready())
    expect(requests.at(-1)).toBeNull()
    const nextNonce = /var NONCE = "([^"]+)"/.exec(iframe.getAttribute('srcdoc') ?? '')?.[1]
    expect(nextNonce).not.toBe(nonce)
    act(() => ready(nextNonce))
    expect(requests.at(-1)).toBeFunction()
    expect(requests.at(-1)).not.toBe(request)
  })

  it('rejects foreign-frame and stale-document ready messages', () => {
    const onReady = mock(() => {})
    const { container } = render(<SandboxedHtmlFrame html="<p>First</p>" title="Page" onReady={onReady} />)
    const iframe = container.querySelector('iframe')!
    const nonce = /var NONCE = "([^"]+)"/.exec(iframe.getAttribute('srcdoc') ?? '')?.[1]
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { source: window, data: { artifactNonce: nonce, type: 'artifact-ready' } }),
      )
      window.dispatchEvent(
        new MessageEvent('message', {
          source: iframe.contentWindow,
          data: { artifactNonce: 'wrong-document', type: 'artifact-ready' },
        }),
      )
    })
    expect(onReady).not.toHaveBeenCalled()
  })
})
