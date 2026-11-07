/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, render } from '@testing-library/react'
import { expect, it, mock } from 'bun:test'
import { mockIntersectionObserver } from '@/test-utils/mock-intersection-observer'
import { useProjectArtifactPreviewState } from './use-project-artifact-preview-state'

const Preview = () => {
  const preview = useProjectArtifactPreviewState()
  return <div ref={preview.ref}>{preview.ready ? <iframe title="Preview" /> : null}</div>
}

it('does not construct an iframe for an offscreen card', async () => {
  const restore = mockIntersectionObserver(false)
  try {
    const { container } = render(<Preview />)
    await act(async () => {})
    expect(container.querySelector('iframe')).toBeNull()
  } finally {
    restore()
  }
})

it('waits for the entrance animation before loading a visible preview', async () => {
  const restore = mockIntersectionObserver(true)
  const animation = Promise.withResolvers<Animation>()
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.getAnimations = mock(() => [{ finished: animation.promise } as Animation])
  document.body.append(dialog)
  try {
    const { container } = render(<Preview />, { container: dialog })
    expect(container.querySelector('iframe')).toBeNull()
    await act(async () => {
      animation.resolve({} as Animation)
    })
    expect(container.querySelector('iframe')).not.toBeNull()
  } finally {
    restore()
    dialog.remove()
  }
})

it('also loads with reduced motion or a canceled animation', async () => {
  const restore = mockIntersectionObserver(true)
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.getAnimations = mock(() => [{ finished: Promise.reject(new Error('Canceled')) } as Animation])
  document.body.append(dialog)
  try {
    const { container } = render(<Preview />, { container: dialog })
    await act(async () => {})
    expect(container.querySelector('iframe')).not.toBeNull()
  } finally {
    restore()
    dialog.remove()
  }
})
