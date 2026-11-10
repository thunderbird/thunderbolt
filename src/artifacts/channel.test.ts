/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { describe, expect, it, mock, spyOn } from 'bun:test'
import { bindArtifactChannel } from './channel'
import { artifactRequest } from './harness-protocol'

const nonce = 'original-document'
const ready = { artifactNonce: nonce, type: 'artifact-ready' }

describe('document-bound artifact channel', () => {
  it('binds only the matching non-null frame, nonce and exactly one transferred port', () => {
    const frameWindow = {} as Window
    const onMessage = mock(() => {})
    const channel = bindArtifactChannel({ getFrameWindow: () => frameWindow, nonce, onMessage })
    const ports = new MessageChannel()
    const send = spyOn(ports.port1, 'postMessage')
    for (const [source, artifactNonce, transferred] of [
      [window, nonce, [ports.port1]],
      [null, nonce, [ports.port1]],
      [frameWindow, 'different-document', [ports.port1]],
      [frameWindow, nonce, []],
    ] as const) {
      window.dispatchEvent(
        new MessageEvent('message', {
          source,
          data: { artifactNonce, type: 'artifact-connect' },
          ports: [...transferred],
        }),
      )
      expect(() => channel.send(artifactRequest(nonce, 1, 'page/snapshot', {}))).toThrow('document changed')
    }
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frameWindow,
        data: { artifactNonce: nonce, type: 'artifact-connect' },
        ports: [ports.port1],
      }),
    )
    ports.port1.onmessage?.(new MessageEvent('message', { data: ready }))
    expect(onMessage).toHaveBeenCalledWith(ready)
    const request = artifactRequest(nonce, 2, 'page/action', { type: 'type', text: 'value' })
    channel.send(request)
    expect(send).toHaveBeenCalledWith(request)
    channel.close()
    ports.port2.close()
  })

  it('ignores window replies and closes duplicate bootstrap ports without replacing the original', () => {
    const onMessage = mock(() => {})
    const onClose = mock(() => {})
    const channel = bindArtifactChannel({ getFrameWindow: () => window, nonce, onMessage, onClose })
    const original = new MessageChannel()
    const duplicate = new MessageChannel()
    const closeDuplicate = spyOn(duplicate.port1, 'close')
    for (const port of [original.port1, duplicate.port1]) {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          data: { artifactNonce: nonce, type: 'artifact-connect' },
          ports: [port],
        }),
      )
    }
    expect(closeDuplicate).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new MessageEvent('message', { source: window, data: ready }))
    original.port1.onmessage?.(new MessageEvent('message', { data: { ...ready, artifactNonce: 'wrong' } }))
    duplicate.port1.onmessage?.(new MessageEvent('message', { data: ready }))
    expect(onMessage).not.toHaveBeenCalled()
    original.port1.onmessage?.(new MessageEvent('message', { data: ready }))
    expect(onMessage).toHaveBeenCalledTimes(1)
    const closeOriginal = spyOn(original.port1, 'close')
    original.port1.onmessage?.(
      new MessageEvent('message', { data: { artifactNonce: nonce, type: 'artifact-disconnect' } }),
    )
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(closeOriginal).toHaveBeenCalledTimes(1)
    original.port1.onmessage?.(new MessageEvent('message', { data: ready }))
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(() => channel.send(artifactRequest(nonce, 3, 'page/snapshot', {}))).toThrow('document changed')
    channel.close()
    expect(onClose).toHaveBeenCalledTimes(1)
    original.port2.close()
    duplicate.port2.close()
  })

  it('rejects a null frame even when a message also has a null source', () => {
    const channel = bindArtifactChannel({ getFrameWindow: () => null, nonce, onMessage: () => {} })
    const ports = new MessageChannel()
    window.dispatchEvent(
      new MessageEvent('message', {
        source: null,
        data: { artifactNonce: nonce, type: 'artifact-connect' },
        ports: [ports.port1],
      }),
    )
    expect(() => channel.send(artifactRequest(nonce, 1, 'page/snapshot', {}))).toThrow('document changed')
    channel.close()
    ports.port1.close()
    ports.port2.close()
  })
})
