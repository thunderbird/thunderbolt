/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, render } from '@testing-library/react'
import { describe, expect, it, mock, spyOn } from 'bun:test'
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
    Object.defineProperty(iframe, 'contentWindow', { value: {} as Window })
    const nonce = /var NONCE = "([^"]+)"/.exec(iframe.getAttribute('srcdoc') ?? '')?.[1]
    expect(nonce).toBeTruthy()
    const connect = (port: MessagePort, artifactNonce = nonce) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: iframe.contentWindow,
          data: { artifactNonce, type: 'artifact-connect' },
          ports: [port],
        }),
      )
    const ports = new MessageChannel()
    const closed = spyOn(ports.port1, 'close')
    const ready = () =>
      ports.port1.onmessage?.(new MessageEvent('message', { data: { artifactNonce: nonce, type: 'artifact-ready' } }))
    act(() => {
      connect(ports.port1)
      ready()
      ready()
    })
    expect(onRequestReady).toHaveBeenCalledTimes(1)
    const request = requests[0]!
    const pending = request('page/snapshot', {})
    rerender(<SandboxedHtmlFrame html="<p>Second</p>" title="Page" onRequestReady={onRequestReady} />)
    expect(requests.at(-1)).toBeNull()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(await pending).toBeNull()
    await expect(request('page/snapshot', {})).rejects.toThrow('document changed')
    act(() => ready())
    expect(requests.at(-1)).toBeNull()
    const nextNonce = /var NONCE = "([^"]+)"/.exec(iframe.getAttribute('srcdoc') ?? '')?.[1]
    expect(nextNonce).not.toBe(nonce)
    const nextPorts = new MessageChannel()
    act(() => {
      connect(nextPorts.port1, nextNonce)
      nextPorts.port1.onmessage?.(
        new MessageEvent('message', { data: { artifactNonce: nextNonce, type: 'artifact-ready' } }),
      )
    })
    expect(requests.at(-1)).toBeFunction()
    expect(requests.at(-1)).not.toBe(request)
    ports.port2.close()
    nextPorts.port2.close()
  })

  it('revokes pending and retained requests when the original document navigates away', async () => {
    type Request = (method: string, params: unknown) => Promise<unknown>
    const requests: (Request | null)[] = []
    const { container } = render(
      <SandboxedHtmlFrame html="<p>Page</p>" title="Page" onRequestReady={(request) => requests.push(request)} />,
    )
    const iframe = container.querySelector('iframe')!
    Object.defineProperty(iframe, 'contentWindow', { value: {} as Window })
    const nonce = /var NONCE = "([^"]+)"/.exec(iframe.getAttribute('srcdoc') ?? '')?.[1]
    const ports = new MessageChannel()
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: iframe.contentWindow,
          data: { artifactNonce: nonce, type: 'artifact-connect' },
          ports: [ports.port1],
        }),
      )
      ports.port1.onmessage?.(new MessageEvent('message', { data: { artifactNonce: nonce, type: 'artifact-ready' } }))
    })
    const request = requests[0]!
    const pending = request('page/action', { type: 'type', text: 'value' })
    act(() => {
      ports.port1.onmessage?.(
        new MessageEvent('message', { data: { artifactNonce: nonce, type: 'artifact-disconnect' } }),
      )
      ports.port1.onmessage?.(
        new MessageEvent('message', { data: { artifactNonce: nonce, type: 'artifact-reply', id: 1, result: true } }),
      )
    })
    expect(requests.at(-1)).toBeNull()
    expect(await pending).toBeNull()
    await expect(request('page/action', { type: 'type', text: 'later' })).rejects.toThrow('document changed')
    ports.port2.close()
  })

  it('rejects foreign-frame and stale-document ready messages', () => {
    const onReady = mock(() => {})
    const { container } = render(<SandboxedHtmlFrame html="<p>First</p>" title="Page" onReady={onReady} />)
    const iframe = container.querySelector('iframe')!
    Object.defineProperty(iframe, 'contentWindow', { value: {} as Window })
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
