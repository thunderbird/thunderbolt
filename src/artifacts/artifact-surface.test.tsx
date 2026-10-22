/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { ArtifactSurface } from './artifact-surface'
import { artifactId, type Artifact } from './artifact'
import { getActiveArtifactSession, useArtifactSessionStore } from './artifact-session-store'
import { getArtifactContextSnapshot, useArtifactContextStore } from './artifact-context-store'

const artifact: Artifact = {
  id: artifactId({ kind: 'html', messageId: 'message', toolCallId: 'call' }),
  reference: { kind: 'html', messageId: 'message', toolCallId: 'call' },
  title: 'Chart',
  chatThreadId: 'chat',
  source: { kind: 'html', html: '<h1>Revenue</h1>' },
}
const ask = () => {}

describe('ArtifactSurface', () => {
  it('preserves frame context on rename but clears it when the document changes', () => {
    const { container, rerender, unmount } = render(<ArtifactSurface artifact={artifact} onAsk={ask} />)
    const frame = container.querySelector('iframe')
    const owner = getActiveArtifactSession()!.owner
    const context = { title: 'Revenue', summary: 'The selected quarter is Q3.' }
    act(() => useArtifactContextStore.getState().setContext(context, owner))
    rerender(<ArtifactSurface artifact={{ ...artifact, title: 'Renamed' }} onAsk={ask} />)
    expect(container.querySelector('iframe')).toBe(frame)
    expect(getArtifactContextSnapshot(owner)).toEqual({ title: 'Renamed', context })
    rerender(
      <ArtifactSurface
        artifact={{ ...artifact, title: 'New document', source: { kind: 'html', html: '<h1>New</h1>' } }}
        onAsk={ask}
      />,
    )
    expect(getArtifactContextSnapshot(owner)).toEqual({ title: 'New document', context: null })
    unmount()
    expect(getArtifactContextSnapshot(owner)).toEqual({ title: null, context: null })
  })

  it('keeps scripts-off previews out of agent context and under the offline sandbox', () => {
    const { container } = render(<ArtifactSurface artifact={artifact} onAsk={ask} allowScripts={false} autoHeight />)
    const frame = container.querySelector('iframe')
    expect(frame?.getAttribute('sandbox')).toBe('')
    expect(frame?.getAttribute('srcdoc')).toContain('Content-Security-Policy')
    expect(useArtifactSessionStore.getState().sessions.size).toBe(0)
  })

  it('registers expanded HTML with the same strict sandbox and releases it on close', () => {
    const { container, unmount } = render(<ArtifactSurface artifact={artifact} onAsk={ask} />)
    const owner = getActiveArtifactSession()?.owner ?? null
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(getArtifactContextSnapshot(owner).title).toBe('Chart')
    unmount()
    expect(getActiveArtifactSession()).toBeNull()
    expect(getArtifactContextSnapshot(owner).title).toBeNull()
  })

  it('lets explicit inline interaction take focus and restores the expanded owner on unmount', () => {
    const expanded = render(<ArtifactSurface artifact={artifact} onAsk={ask} />)
    const expandedOwner = getActiveArtifactSession()?.owner
    const inline = render(
      <ArtifactSurface artifact={{ ...artifact, id: 'second', title: 'Second' }} onAsk={ask} autoHeight />,
    )
    expect(getActiveArtifactSession()?.owner).toBe(expandedOwner)
    fireEvent.pointerDown(inline.container.querySelector('button')!)
    expect(getActiveArtifactSession()?.artifactId).toBe('second')
    inline.unmount()
    expect(getActiveArtifactSession()?.owner).toBe(expandedOwner)
    expanded.unmount()
  })

  it('activates only the frame that receives focus when the parent window blurs', () => {
    const first = render(<ArtifactSurface artifact={artifact} onAsk={ask} />)
    const firstOwner = getActiveArtifactSession()?.owner
    const second = render(<ArtifactSurface artifact={{ ...artifact, id: 'second' }} onAsk={ask} autoHeight />)
    const frame = second.container.querySelector('iframe')!
    act(() => {
      frame.focus()
      window.dispatchEvent(new Event('blur'))
    })
    expect(getActiveArtifactSession()?.artifactId).toBe('second')
    second.unmount()
    act(() => window.dispatchEvent(new Event('blur')))
    expect(getActiveArtifactSession()?.owner).toBe(firstOwner)
    first.unmount()
  })

  it('returns context ownership to a visible surface while an inline frame is hidden', () => {
    render(<ArtifactSurface artifact={artifact} onAsk={ask} />)
    const expandedOwner = getActiveArtifactSession()!.owner
    const inlineArtifact = { ...artifact, id: 'inline' }
    const inline = render(<ArtifactSurface artifact={inlineArtifact} onAsk={ask} autoHeight />)
    const frame = inline.container.querySelector('iframe')!
    fireEvent.pointerDown(inline.container.querySelector('button')!)
    const inlineOwner = getActiveArtifactSession()!.owner
    const context = { title: 'Revenue', summary: 'The selected quarter is Q3.' }
    act(() => useArtifactContextStore.getState().setContext(context, inlineOwner))
    inline.rerender(<ArtifactSurface artifact={inlineArtifact} onAsk={ask} autoHeight visible={false} />)
    expect(getActiveArtifactSession()?.owner).toBe(expandedOwner)
    fireEvent.pointerDown(inline.container.querySelector('button')!)
    expect(getActiveArtifactSession()?.owner).toBe(expandedOwner)
    inline.rerender(<ArtifactSurface artifact={inlineArtifact} onAsk={ask} autoHeight />)
    expect(inline.container.querySelector('iframe')).toBe(frame)
    fireEvent.pointerDown(inline.container.querySelector('button')!)
    expect(getActiveArtifactSession()?.owner).toBe(inlineOwner)
    expect(getArtifactContextSnapshot(inlineOwner)).toEqual({ title: 'Chart', context })
  })

  it('tracks focus moving directly between iframe documents without a second parent blur', async () => {
    const first = render(<ArtifactSurface artifact={artifact} onAsk={ask} />)
    const firstOwner = getActiveArtifactSession()?.owner
    const second = render(<ArtifactSurface artifact={{ ...artifact, id: 'second' }} onAsk={ask} autoHeight />)
    act(() => {
      first.container.querySelector('iframe')!.focus()
      window.dispatchEvent(new Event('blur'))
    })
    await act(async () => {
      second.container.querySelector('iframe')!.focus()
      await getClock().tickAsync(20)
    })
    expect(getActiveArtifactSession()?.artifactId).toBe('second')
    await act(async () => {
      first.container.querySelector('iframe')!.focus()
      await getClock().tickAsync(20)
    })
    expect(getActiveArtifactSession()?.owner).toBe(firstOwner)
  })

  it('replaces ownership when the source identity changes without leaving stale context', () => {
    const { rerender } = render(<ArtifactSurface artifact={artifact} onAsk={ask} />)
    const oldOwner = getActiveArtifactSession()?.owner ?? null
    act(() =>
      rerender(<ArtifactSurface artifact={{ ...artifact, id: 'replacement', title: 'Replacement' }} onAsk={ask} />),
    )
    expect(getActiveArtifactSession()?.artifactId).toBe('replacement')
    expect(getArtifactContextSnapshot(oldOwner).title).toBeNull()
    expect(useArtifactSessionStore.getState().sessions.size).toBe(1)
  })
})
