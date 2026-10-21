/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as attachmentStorage from '@/lib/file-blob-storage'
import { getClock } from '@/testing-library'
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn, type Mock } from 'bun:test'
import type { ReactNode } from 'react'
import remarkGfm from 'remark-gfm'
import { FileCard } from './file-card'
import { MarkdownThumbnail } from './markdown-thumbnail'

const gfmKey = ['markdown-thumbnail-gfm']
const markdown = '# Preview heading\n\n~~Removed text~~'

const flush = () => act(async () => void (await getClock().runAllAsync()))

describe('MarkdownThumbnail GFM loading', () => {
  const clients: QueryClient[] = []
  let attachment: Mock<typeof attachmentStorage.getAttachment>

  const createWrapper = () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, throwOnError: true } },
    })
    clients.push(client)
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    return { client, wrapper }
  }

  beforeEach(() => {
    attachment = spyOn(attachmentStorage, 'getAttachment').mockResolvedValue({
      id: 'markdown-file',
      filename: 'notes.md',
      mimeType: 'text/markdown',
      size: markdown.length,
      createdAt: 0,
      blob: new Blob([markdown]),
    })
  })

  afterEach(() => {
    cleanup()
    for (const client of clients.splice(0)) {
      client.clear()
    }
    onlineManager.setOnline(true)
    attachment.mockRestore()
  })

  it('does not load GFM when the attachment is unavailable', async () => {
    attachment.mockResolvedValue(null)
    const { client, wrapper } = createWrapper()
    const { container } = render(<MarkdownThumbnail localFileId="missing" />, { wrapper })

    await flush()

    expect(container).toBeEmptyDOMElement()
    expect(client.getQueryState(gfmKey)?.fetchStatus).toBe('idle')
    expect(client.getQueryData(gfmKey)).toBeUndefined()
  })

  it('shares a pending GFM load and keeps the file controls usable', async () => {
    const { client, wrapper } = createWrapper()
    const pending = Promise.withResolvers<typeof remarkGfm>()
    const load = mock(() => pending.promise)
    const loading = client.fetchQuery({ queryKey: gfmKey, queryFn: load })
    const onOpen = mock()
    const onRemove = mock()
    render(
      <>
        <FileCard localFileId="markdown-file" filename="notes.md" mimeType="text/markdown" onOpen={onOpen} />
        <FileCard localFileId="other-file" filename="draft.md" mimeType="text/markdown" onRemove={onRemove} />
      </>,
      { wrapper },
    )

    await flush()

    expect(screen.queryByRole('heading', { name: 'Preview heading' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /notes.md/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove draft.md' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve(remarkGfm)
      await loading
    })
    await flush()

    expect(screen.getAllByRole('heading', { name: 'Preview heading' })).toHaveLength(2)
    expect(document.querySelectorAll('del')).toHaveLength(2)
  })

  it('keeps the card on import failure and retries when mounted again', async () => {
    const { client, wrapper } = createWrapper()
    const pending = Promise.withResolvers<typeof remarkGfm>()
    const loading = client.fetchQuery({ queryKey: gfmKey, queryFn: () => pending.promise })
    const failure = loading.catch((error: unknown) => error)
    const onOpen = mock()
    const card = <FileCard localFileId="markdown-file" filename="notes.md" mimeType="text/markdown" onOpen={onOpen} />
    const first = render(card, { wrapper })
    await flush()

    pending.reject(new Error('Chunk unavailable'))
    await flush()

    expect(await failure).toEqual(new Error('Chunk unavailable'))
    expect(client.getQueryState(gfmKey)?.status).toBe('error')
    expect(screen.queryByRole('heading', { name: 'Preview heading' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /notes.md/ }))
    expect(onOpen).toHaveBeenCalledTimes(1)

    first.unmount()
    render(card, { wrapper })
    await flush()
    await act(async () => void (await client.getQueryCache().find({ queryKey: gfmKey })?.promise))
    await flush()

    expect(screen.getByRole('heading', { name: 'Preview heading' })).toBeInTheDocument()
    expect(client.getQueryState(gfmKey)?.status).toBe('success')
  })

  it('loads the bundled GFM plugin even when the device is offline', async () => {
    onlineManager.setOnline(false)
    const { client, wrapper } = createWrapper()
    render(<MarkdownThumbnail localFileId="markdown-file" />, { wrapper })

    await flush()
    await act(async () => void (await client.getQueryCache().find({ queryKey: gfmKey })?.promise))
    await flush()

    expect(screen.getByRole('heading', { name: 'Preview heading' })).toBeInTheDocument()
    expect(screen.getByText('Removed text').tagName).toBe('DEL')
    expect(client.getQueryState(gfmKey)?.status).toBe('success')
  })
})
