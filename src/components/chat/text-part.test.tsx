/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { TextUIPart } from 'ai'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { ExternalLinkDialogProvider } from './markdown-utils'
import { TextPart } from './text-part'
import * as smoothText from '@/hooks/use-smooth-text'

it('paces only active text parts and flushes both terminal gates synchronously', () => {
  const text = 'Steady answer. '.repeat(100)
  const props = { part: { type: 'text', text, state: 'streaming' } as TextUIPart, messageId: 'test', isStreaming: true }
  const { container, rerender } = render(<TextPart {...props} />)
  expect(container.textContent).toBe('')
  act(() => getClock().tick(48))
  expect(container.textContent!.length).toBeGreaterThan(0)
  expect(container.textContent!.length).toBeLessThan(text.length)
  rerender(<TextPart {...props} part={{ ...props.part, state: 'done' }} />)
  expect(container.textContent).toBe(text.trim())
  rerender(<TextPart {...props} isStreaming={false} />)
  expect(container.textContent).toBe(text.trim())
  expect(props.part.text).toBe(text)
})

it('paces raw source citations without exposing generated CITE placeholders', () => {
  const text = 'Evidence [1] and more text. '.repeat(30)
  const { container } = render(
    <TextPart
      part={{ type: 'text', text, state: 'streaming' }}
      messageId="citation"
      isStreaming
      sources={[{ index: 1, url: 'https://example.com', title: 'Example', toolName: 'search' }]}
    />,
  )
  expect(container.textContent).toBe('')
  for (const _ of Array.from({ length: 80 })) {
    act(() => getClock().tick(16))
    expect(container.textContent).not.toContain('CITE')
    expect(container.textContent).not.toContain('{{')
  }
  expect(container.textContent).toContain('Evidence')
  expect(container.querySelector('button')).not.toBeNull()
})

it('completes native citation syntax without retaining internal markers', () => {
  const text = 'Fact【2†source】. Another fact【3】.'
  const { container } = render(
    <TextPart part={{ type: 'text', text, state: 'streaming' }} messageId="native" isStreaming />,
  )
  const frames: string[] = []
  for (const _ of Array.from({ length: 30 })) {
    act(() => getClock().tick(16))
    frames.push(container.textContent ?? '')
  }
  expect(container.textContent).toBe('Fact. Another fact.')
  expect(frames.some((frame) => frame.includes('【'))).toBe(false)
})

it('preserves CJK brackets and flushes unfinished native syntax on stop', () => {
  const props = {
    messageId: 'cjk',
    isStreaming: true,
    part: { type: 'text', state: 'streaming', text: '価格は【税込み】です【2†source' } as TextUIPart,
  }
  const { container, rerender } = render(<TextPart {...props} />)
  act(() => getClock().tick(1000))
  expect(container.textContent).toBe('価格は【税込み】です')
  rerender(<TextPart {...props} isStreaming={false} />)
  expect(container.textContent).toBe(props.part.text)
})

describe('streaming widgets', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  it('holds hidden attributes until the real widget mounts, preserving surrounding text order', () => {
    const url = 'https://example.com/' + 'a'.repeat(1000)
    const text = `Intro <widget:link-preview url="${url}" source="1" /> Tail`
    const Provider = createTestProvider()
    const { container, rerender } = render(
      <TextPart
        messageId="widget"
        precedesActivity
        part={{ type: 'text', text, state: 'streaming' }}
        isStreaming
        sources={[{ index: 1, url, title: 'Widget title', toolName: 'search' }]}
      />,
      {
        wrapper: ({ children }) => (
          <Provider>
            <ExternalLinkDialogProvider>{children}</ExternalLinkDialogProvider>
          </Provider>
        ),
      },
    )
    const observed = { widgetAt: 0 }
    for (const frame of Array.from({ length: 80 }, (_, index) => index + 1)) {
      act(() => getClock().tick(16))
      expect(container.textContent).not.toContain('widget:')
      expect(container.textContent).not.toContain('https://')
      if (!observed.widgetAt && container.textContent?.includes('Widget title')) {
        observed.widgetAt = frame * 16
      }
    }
    expect(observed.widgetAt).toBeGreaterThan(900)
    expect(observed.widgetAt).toBeLessThan(1100)
    expect(container.textContent).toBe('IntroWidget titleTail')
    expect(container.firstElementChild).not.toHaveClass('pb-0', 'mb-0')
    expect(container.lastElementChild).toHaveClass('pb-0', 'mb-0')
    rerender(<TextPart messageId="widget" part={{ type: 'text', text: 'Replacement answer', state: 'done' }} />)
    expect(container.textContent).toBe('Replacement answer')
  })
})

it.each(['', ' [1]'])('makes private-source Markdown images explicit links (citations: %s)', (citation) => {
  const { container } = render(
    <ExternalLinkDialogProvider>
      <TextPart
        messageId="private-image"
        part={{ type: 'text', text: `![Source image](https://example.com/tracker.png)${citation}`, state: 'done' }}
        sources={[
          {
            index: 1,
            url: 'https://example.com/article',
            title: 'Source',
            toolName: 'search',
            allowRemoteImages: false,
          },
        ]}
      />
    </ExternalLinkDialogProvider>,
  )
  expect(container.querySelector('img')).toBeNull()
  const link = screen.getByRole('link', { name: 'Source image' })
  expect(link).toHaveAttribute('href', 'https://example.com/tracker.png')
  fireEvent.click(link)
  expect(screen.getByRole('alertdialog')).toBeInTheDocument()
})

it.each(['//example.com/image.png', 'https:example.com/image.png'])(
  'does not bypass private-source policy with a noncanonical Markdown image %s',
  (url) => {
    const { container, getByRole } = render(
      <ExternalLinkDialogProvider>
        <TextPart
          messageId="relative-remote-image"
          part={{ type: 'text', text: `![Image](${url})`, state: 'done' }}
          sources={[
            {
              index: 1,
              url: 'https://example.com/article',
              title: 'Source',
              toolName: 'search',
              allowRemoteImages: false,
            },
          ]}
        />
      </ExternalLinkDialogProvider>,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(getByRole('link')).toHaveAttribute('href', 'https://example.com/image.png')
  },
)

it.each([
  { src: '/attachments/local-image.png', allowRemoteImages: false },
  { src: 'https://example.com/image.png', allowRemoteImages: undefined },
])('preserves local attachments and ordinary-message images ($src)', ({ src, allowRemoteImages }) => {
  const { container } = render(
    <TextPart
      messageId="ordinary-image"
      part={{ type: 'text', text: `![Image](${src})`, state: 'done' }}
      sources={[
        { index: 1, url: 'https://example.com/article', title: 'Source', toolName: 'search', allowRemoteImages },
      ]}
    />,
  )
  expect(container.querySelector('img')).toHaveAttribute('src', src)
})

it.each([
  String.raw`\\example.com/image.png`,
  String.raw`/\example.com/image.png`,
  '&#92;&#92;example.com/image.png',
  '&#47;&#9;&#47;example.com/image.png',
])('keeps escaped Markdown image punctuation on the document origin (%s)', (url) => {
  const { container } = render(
    <ExternalLinkDialogProvider>
      <TextPart
        messageId="escaped-image"
        part={{ type: 'text', text: `![Image](<${url}>)`, state: 'done' }}
        sources={[
          {
            index: 1,
            url: 'https://example.com/article',
            title: 'Source',
            toolName: 'search',
            allowRemoteImages: false,
          },
        ]}
      />
    </ExternalLinkDialogProvider>,
  )
  const image = container.querySelector('img')
  expect(image).toBeInTheDocument()
  // The DOM harness starts at about:blank; resolve as a browser-hosted app would.
  const documentUrl = new URL('https://app.example/chats/new')
  expect(new URL(image!.getAttribute('src')!, documentUrl).origin).toBe(documentUrl.origin)
})

it('leaves completed text parts stable when another part streams, and updates text and citation inputs', () => {
  const reveal = spyOn(smoothText, 'useSmoothText')
  const part: TextUIPart = { type: 'text', text: 'Settled text [1].', state: 'done' }
  try {
    const { rerender, container } = render(<TextPart part={part} messageId="stable" isStreaming />)
    const initial = reveal.mock.calls.length
    for (const isStreaming of [true, false, undefined, ...Array.from({ length: 20 }, (_, index) => index % 2 === 0)]) {
      rerender(<TextPart part={{ ...part }} messageId="stable" isStreaming={isStreaming} />)
    }
    expect(reveal.mock.calls.length).toBe(initial)
    const sources = [{ index: 1, url: 'https://example.com', title: 'Source', toolName: 'search' }]
    rerender(<TextPart part={{ ...part }} messageId="stable" sources={sources} />)
    expect(reveal.mock.calls.length).toBe(initial + 1)
    expect(container.querySelector('button')).not.toBeNull()
    rerender(<TextPart part={{ ...part, text: 'Corrected answer.' }} messageId="stable" />)
    expect(container.textContent).toBe('Corrected answer.')
  } finally {
    reveal.mockRestore()
  }
})

it('updates late document references and removes citations when their metadata disappears', () => {
  const part: TextUIPart = { type: 'text', text: 'Evidence [1].', state: 'done' }
  const { container, rerender } = render(<TextPart part={part} messageId="late-reference" />)
  expect(container.textContent).toBe('Evidence [1].')

  rerender(
    <TextPart
      part={{ ...part }}
      messageId="late-reference"
      haystackReferences={[{ position: 1, fileId: 'report', fileName: 'report.pdf', pageNumber: 2 }]}
    />,
  )
  expect(container.querySelector('button')?.textContent).toBe('PDF')

  rerender(
    <TextPart
      part={{ ...part }}
      messageId="late-reference"
      haystackReferences={[{ position: 1, fileId: 'notes', fileName: 'notes.docx' }]}
    />,
  )
  expect(container.querySelector('button')?.textContent).toBe('DOCX')

  rerender(<TextPart part={{ ...part }} messageId="late-reference" />)
  expect(container.querySelector('button')).toBeNull()
  expect(container.textContent).toBe('Evidence [1].')
})

it.each([false, true])(
  'compacts text after activity while preserving normal message spacing (citations: %s)',
  (cited) => {
    const props = {
      part: { type: 'text', text: cited ? 'Now writing the game [1].' : 'Now writing the game.' } as TextUIPart,
      messageId: 'spacing',
      sources: cited ? [{ index: 1, url: 'https://example.com', title: 'Example', toolName: 'search' }] : undefined,
    }
    const { container, rerender } = render(<TextPart {...props} />)
    expect(container.firstElementChild).toHaveClass('p-4', 'my-2')
    expect(container.firstElementChild).not.toHaveClass('pt-2')
    rerender(<TextPart {...props} followsActivity />)
    expect(container.firstElementChild).toHaveClass('pt-2', 'mt-0')
    rerender(<TextPart {...props} followsActivity={false} />)
    expect(container.firstElementChild).not.toHaveClass('pt-2', 'mt-0')
  },
)

it.each([false, true])(
  'compacts only trailing text before activity and updates memoized spacing (citations: %s)',
  (cited) => {
    const props = {
      part: { type: 'text', text: cited ? 'Now writing the game [1].' : 'Now writing the game.' } as TextUIPart,
      messageId: 'trailing-spacing',
      sources: cited ? [{ index: 1, url: 'https://example.com', title: 'Example', toolName: 'search' }] : undefined,
    }
    const { container, rerender } = render(<TextPart {...props} />)
    expect(container.firstElementChild).not.toHaveClass('pb-0', 'mb-0')
    rerender(<TextPart {...props} precedesActivity />)
    expect(container.firstElementChild).toHaveClass('pb-0', 'mb-0', '[&_.prose>div:last-child>:last-child]:mb-0')
    expect(container.firstElementChild).not.toHaveClass('pt-2', 'mt-0')
    rerender(<TextPart {...props} followsActivity precedesActivity />)
    expect(container.firstElementChild).toHaveClass('pt-2', 'mt-0', 'pb-0', 'mb-0')
    rerender(<TextPart {...props} precedesActivity={false} />)
    expect(container.firstElementChild).not.toHaveClass('pb-0', 'mb-0')
  },
)
