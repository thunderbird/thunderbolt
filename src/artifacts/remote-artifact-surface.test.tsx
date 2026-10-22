/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act, render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { AppWindow } from 'lucide-react'
import { HttpClientProvider } from '@/contexts'
import { createClient } from '@/lib/http'
import { ThemeProvider } from '@/lib/theme-provider'
import { miniAppProtocolMarker, miniAppProtocolVersion } from '@shared/mini-app-protocol'
import { getMiniAppSnapshot } from '@/mini-apps/mini-app-store'
import { RemoteArtifactSurface } from './remote-artifact-surface'

const app = {
  id: 'books',
  name: 'Books',
  description: '',
  url: 'https://books.test',
  origin: 'https://books.test',
  icon: AppWindow,
}
const httpClient = createClient({ prefixUrl: 'https://api.test', fetch: async () => new Response('{}') })
const noAction = () => {}

const mount = (owner: string, onChatOpen = (_prompt?: string) => {}, autoHeight = false) => {
  const result = render(
    <ThemeProvider>
      <HttpClientProvider httpClient={httpClient}>
        <RemoteArtifactSurface
          app={app}
          owner={owner}
          onAsk={noAction}
          onChatOpen={onChatOpen}
          onActivate={noAction}
          autoHeight={autoHeight}
        />
      </HttpClientProvider>
    </ThemeProvider>,
  )
  const frame = result.container.querySelector('iframe')!
  const send = async (data: Record<string, unknown>) => {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: app.origin,
          data: { jsonrpc: '2.0', protocol: miniAppProtocolMarker, ...data },
        }),
      )
      await getClock().tickAsync(1)
    })
  }
  return { ...result, frame, send }
}

describe('RemoteArtifactSurface', () => {
  it('keeps remote origins isolated in both inline and expanded presentations', () => {
    const inline = mount('inline', undefined, true)
    const expanded = mount('expanded')
    for (const frame of [inline.frame, expanded.frame]) {
      expect(frame.getAttribute('src')).toBe(app.url)
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-popups')
      expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
      expect(frame.getAttribute('allow')).toBe('')
    }
    expect(getMiniAppSnapshot('inline').app?.id).toBe('books')
    expect(getMiniAppSnapshot('expanded').app?.id).toBe('books')
    inline.unmount()
    expect(getMiniAppSnapshot('inline').app).toBeNull()
    expect(getMiniAppSnapshot('expanded').app?.id).toBe('books')
  })

  it('preserves prompts when the remote guest opens a conversation', async () => {
    const prompts: (string | undefined)[] = []
    const { send } = mount('prompt', (prompt) => prompts.push(prompt))
    await send({
      id: 1,
      method: 'ui/initialize',
      params: { protocolVersion: miniAppProtocolVersion, documentId: 'doc', capabilities: {} },
    })
    await send({ id: 2, method: 'ui/open-chat', params: { prompt: 'Explain these figures' } })
    expect(prompts).toEqual(['Explain these figures'])
  })

  it('keeps a runtime error confined to the frame that reported it', async () => {
    const first = mount('first')
    const second = mount('second')
    await first.send({ method: 'ui/notifications/error', params: { message: 'First chart failed' } })
    expect(first.container.textContent).toContain('First chart failed')
    expect(second.container.textContent).not.toContain('First chart failed')
  })
})
