/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ContentViewProvider, useSideview } from '@/content-view/context'
import { docxMime, pptxMime, xlsxMime } from '@/files/transformers'
import * as download from '@/lib/download'
import * as attachmentStorage from '@/lib/file-blob-storage'
import { getClock } from '@/testing-library'
import type { ThunderboltUIMessage } from '@/types'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from 'bun:test'
import { AssistantMessage } from './assistant-message'

const report = { id: 'file-1', filename: 'report.docx', mimeType: docxMime }
const deck = { id: 'file-2', filename: 'deck.pptx', mimeType: pptxMime }
const budget = { id: 'file-3', filename: 'budget.xlsx', mimeType: xlsxMime }
const bytes = new Uint8Array([80, 75, 3, 4])
const storedFiles = [report, deck, budget].map((file) => ({
  ...file,
  size: bytes.byteLength,
  createdAt: 0,
  blob: new Blob([bytes], { type: file.mimeType }),
}))

const finishedCall = (output: ToolUIPart['output']): ToolUIPart => ({
  type: 'tool-run_office_script',
  toolCallId: 'call-1',
  state: 'output-available',
  input: { script: 'saveFile(…)' },
  output,
})

const OpenSideview = () => {
  const { sideviewType, sideviewId } = useSideview()
  return <p data-testid="sideview">{`${sideviewType}|${sideviewId}`}</p>
}

const renderMessage = async (part: ToolUIPart | DynamicToolUIPart) => {
  const message: ThunderboltUIMessage = { id: 'm1', role: 'assistant', parts: [part] }
  const view = render(
    <ContentViewProvider>
      <AssistantMessage message={message} isStreaming={false} />
    </ContentViewProvider>,
  )
  await act(async () => void (await getClock().runAllAsync()))
  return view
}

describe('the chip for a file the agent created', () => {
  let getAttachment: Mock<typeof attachmentStorage.getAttachment>
  let downloadFile: Mock<typeof download.downloadFile>

  beforeEach(() => {
    getAttachment = spyOn(attachmentStorage, 'getAttachment').mockImplementation(
      async (id) => storedFiles.find((file) => file.id === id) ?? null,
    )
    downloadFile = spyOn(download, 'downloadFile').mockResolvedValue('report.docx')
  })

  afterEach(() => {
    cleanup()
    getAttachment.mockRestore()
    downloadFile.mockRestore()
  })

  it('shows the file name and its type, and downloads the stored bytes', async () => {
    await renderMessage(finishedCall({ ok: true, files: [report], logs: '' }))

    expect(screen.getByText('report.docx')).toBeDefined()
    expect(screen.getByText('DOCX')).toBeDefined()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download report.docx' }))
      await getClock().runAllAsync()
    })
    expect(downloadFile).toHaveBeenCalledWith({ name: 'report.docx', contents: bytes, mimeType: docxMime })
  })

  it('shows and saves the stored name and type, whatever name the tool result gives', async () => {
    await renderMessage(
      finishedCall({ ok: true, files: [{ ...report, filename: 'x.html', mimeType: 'text/html' }], logs: '' }),
    )

    expect(screen.queryByText('x.html')).toBeNull()
    expect(screen.getByText('DOCX')).toBeDefined()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download report.docx' }))
      await getClock().runAllAsync()
    })
    expect(downloadFile).toHaveBeenCalledWith({ name: 'report.docx', contents: bytes, mimeType: docxMime })
  })

  it('shows one chip per file, with a presentation icon for a deck', async () => {
    const { container } = await renderMessage(finishedCall({ ok: true, files: [report, deck], logs: '' }))

    expect(screen.getByText('deck.pptx')).toBeDefined()
    expect(screen.getAllByRole('button', { name: /^Download / })).toHaveLength(2)
    expect(container.querySelectorAll('.lucide-presentation')).toHaveLength(1)
  })

  it('shows a spreadsheet icon for a workbook', async () => {
    const { container } = await renderMessage(finishedCall({ ok: true, files: [budget], logs: '' }))

    expect(screen.getByRole('button', { name: 'Download budget.xlsx' })).toBeDefined()
    expect(container.querySelectorAll('.lucide-file-spreadsheet')).toHaveLength(1)
  })

  it('opens a workbook in the side view, like an attached file', async () => {
    const message: ThunderboltUIMessage = {
      id: 'm1',
      role: 'assistant',
      parts: [finishedCall({ ok: true, files: [budget], logs: '' })],
    }
    render(
      <ContentViewProvider>
        <AssistantMessage message={message} isStreaming={false} />
        <OpenSideview />
      </ContentViewProvider>,
    )
    await act(async () => void (await getClock().runAllAsync()))

    fireEvent.click(screen.getByTitle('budget.xlsx'))

    expect(screen.getByTestId('sideview').textContent).toBe('local-file|file-3:budget.xlsx')
  })

  it('does not open a file that is not on this device', async () => {
    getAttachment.mockResolvedValue(null)
    await renderMessage(finishedCall({ ok: true, files: [budget], logs: '' }))

    expect(screen.queryByTitle('budget.xlsx')).toBeNull()
  })

  it('marks an edited copy, and only that one', async () => {
    await renderMessage(finishedCall({ ok: true, files: [{ ...report, edited: true }, deck], logs: '' }))

    expect(screen.getAllByText('Edited')).toHaveLength(1)
    expect(screen.getByText('Edited').closest('.group')?.textContent).toContain('report.docx')
  })

  it('keeps the running search group expanded and focused when a later save moves the chip', async () => {
    const parts: ThunderboltUIMessage['parts'] = [
      finishedCall({ ok: true, files: [report], logs: '' }),
      { type: 'tool-search', toolCallId: 'search', state: 'input-available', input: { query: 'report' } },
    ]
    const view = (parts: ThunderboltUIMessage['parts']) => (
      <ContentViewProvider>
        <AssistantMessage message={{ id: 'm1', role: 'assistant', parts }} isStreaming />
      </ContentViewProvider>
    )
    const { rerender } = render(view(parts))
    const search = screen.getByRole('button', { name: /Searching/ })
    search.focus()
    fireEvent.click(search)
    expect(search).toHaveAttribute('aria-expanded', 'true')
    expect(document.activeElement).toBe(search)

    rerender(
      view([
        ...parts,
        {
          ...finishedCall({ ok: true, files: [{ ...report, id: 'revised' }], logs: '' }),
          toolCallId: 'save-again',
        },
      ]),
    )
    await act(async () => void (await getClock().runAllAsync()))
    const current = screen.getByRole('button', { name: /Searching/ })
    expect({
      expanded: current.getAttribute('aria-expanded'),
      focused: document.activeElement === current,
    }).toEqual({ expanded: 'true', focused: true })
  })

  it('keeps the expanded disclosure focused when a third version is saved', async () => {
    const view = (ids: string[]) => {
      const parts: ThunderboltUIMessage['parts'] = ids.flatMap((id) => [
        { type: 'text', text: `Saving ${id}` },
        { ...finishedCall({ ok: true, files: [{ ...report, id }], logs: '' }), toolCallId: id },
      ])
      return (
        <ContentViewProvider>
          <AssistantMessage message={{ id: 'm1', role: 'assistant', parts }} isStreaming />
        </ContentViewProvider>
      )
    }
    const { rerender } = render(view(['first', 'second']))
    const disclosure = screen.getByRole('button', { name: '1 earlier version' })
    disclosure.focus()
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')

    rerender(view(['first', 'second', 'third']))
    await act(async () => void (await getClock().runAllAsync()))
    expect(screen.getByRole('button', { name: '2 earlier versions', expanded: true })).toBe(disclosure)
    expect(document.activeElement).toBe(disclosure)
  })

  it('opens each version of an edited file as it was when that chip was made', async () => {
    const versions = ['first', 'second'].map((id, index) => ({
      ...report,
      id,
      size: 1,
      createdAt: index,
      blob: new Blob([new Uint8Array([index + 1])], { type: docxMime }),
    }))
    getAttachment.mockImplementation(async (id) => versions.find((file) => file.id === id) ?? null)
    const message: ThunderboltUIMessage = {
      id: 'm1',
      role: 'assistant',
      parts: [
        finishedCall({ ok: true, files: [{ ...report, id: 'first' }], logs: '' }),
        {
          ...finishedCall({ ok: true, files: [{ ...report, id: 'second', edited: true }], logs: '' }),
          toolCallId: 'c2',
        },
      ],
    }
    render(
      <ContentViewProvider>
        <AssistantMessage message={message} isStreaming={false} />
        <OpenSideview />
      </ContentViewProvider>,
    )
    await act(async () => void (await getClock().runAllAsync()))

    expect(screen.getAllByRole('button', { name: 'Download report.docx' })).toHaveLength(1)
    expect(screen.getByText('Edited')).toBeDefined()
    const disclosure = screen.getByRole('button', { name: '1 earlier version', expanded: false })
    await act(async () => {
      fireEvent.click(disclosure)
      await getClock().runAllAsync()
    })
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByText('Edited')).toHaveLength(1)
    const buttons = screen.getAllByRole('button', { name: 'Download report.docx' })
    const previews = screen.getAllByTitle('report.docx')
    expect(buttons).toHaveLength(2)
    for (const [index, id] of ['second', 'first'].entries()) {
      fireEvent.click(previews[index])
      expect(screen.getByTestId('sideview').textContent).toBe(`local-file|${id}:report.docx`)
      await act(async () => {
        fireEvent.click(buttons[index])
        await getClock().runAllAsync()
      })
    }
    expect(downloadFile.mock.calls.map(([file]) => file.contents)).toEqual([new Uint8Array([2]), new Uint8Array([1])])
    fireEvent.click(disclosure)
    expect(screen.getAllByRole('button', { name: 'Download report.docx' })).toHaveLength(1)
  })

  it('still says an edited copy is not on this device', async () => {
    getAttachment.mockResolvedValue(null)
    await renderMessage(finishedCall({ ok: true, files: [{ ...report, edited: true }], logs: '' }))

    expect(screen.getByText('Edited')).toBeDefined()
    expect(screen.getByText('Not available on this device')).toBeDefined()
  })

  it('says the file is not on this device instead of offering a download', async () => {
    getAttachment.mockResolvedValue(null)
    await renderMessage(finishedCall({ ok: true, files: [report], logs: '' }))

    expect(screen.getByText('report.docx')).toBeDefined()
    expect(screen.getByText('Not available on this device')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Download report.docx' })).toBeNull()
  })

  it('treats a store that cannot be read like a missing file', async () => {
    getAttachment.mockRejectedValue(new Error('IndexedDB unavailable'))
    await renderMessage(finishedCall({ ok: true, files: [report], logs: '' }))

    expect(screen.getByText('Not available on this device')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Download report.docx' })).toBeNull()
  })

  it('shows why a download failed in plain words, not the system text', async () => {
    downloadFile.mockRejectedValue(
      new Error('Could not save report.docx to Downloads: No space left on device (os error 28)'),
    )
    await renderMessage(finishedCall({ ok: true, files: [report], logs: '' }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download report.docx' }))
      await getClock().runAllAsync()
    })
    expect(screen.getByText("Couldn't save: There is not enough free space on this device.")).toBeDefined()
  })

  it('reads the files from the result envelope the harness returns', async () => {
    const result = { ok: true, files: [report], logs: '' }
    await renderMessage(finishedCall({ content: [{ type: 'text', text: JSON.stringify(result) }], details: result }))

    expect(screen.getByRole('button', { name: 'Download report.docx' })).toBeDefined()
  })

  it('shows the chips for a call that arrives as a dynamic tool part', async () => {
    await renderMessage({
      type: 'dynamic-tool',
      toolName: 'run_office_script',
      toolCallId: 'call-3',
      state: 'output-available',
      input: {},
      output: { ok: true, files: [report], logs: '' },
    })

    expect(screen.getByRole('button', { name: 'Download report.docx' })).toBeDefined()
  })

  it('shows no chip while the script runs or when it failed', async () => {
    await renderMessage({ type: 'tool-run_office_script', toolCallId: 'call-2', state: 'input-available', input: {} })
    expect(screen.queryByText('report.docx')).toBeNull()
    cleanup()

    await renderMessage(finishedCall({ ok: false, error: 'Error: boom', logs: '' }))
    expect(screen.queryByText('report.docx')).toBeNull()
  })

  it('holds the chips while the turn is active and shows them once it ends', async () => {
    const parts: ThunderboltUIMessage['parts'] = [
      { ...finishedCall({ ok: true, files: [{ ...report, id: 'draft' }], logs: '' }), toolCallId: 'draft' },
      { type: 'text', text: 'Here is the report.' },
      { ...finishedCall({ ok: true, files: [report], logs: '' }), toolCallId: 'final' },
    ]
    const view = (active: boolean) => (
      <ContentViewProvider>
        <AssistantMessage message={{ id: 'm1', role: 'assistant', parts }} isStreaming={active} holdFiles={active} />
      </ContentViewProvider>
    )
    const { rerender } = render(view(true))
    await act(async () => void (await getClock().runAllAsync()))
    expect(screen.getByText('Here is the report.')).toBeDefined()
    expect(screen.queryByText('report.docx')).toBeNull()
    expect(screen.queryByRole('button', { name: '1 earlier version' })).toBeNull()

    rerender(view(false))
    await act(async () => void (await getClock().runAllAsync()))
    expect(screen.getAllByRole('button', { name: 'Download report.docx' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: '1 earlier version' })).toBeDefined()
  })

  it('keeps the reply text from replaying its fade-in when the held chips appear', async () => {
    const parts: ThunderboltUIMessage['parts'] = [
      finishedCall({ ok: true, files: [report], logs: '' }),
      { type: 'text', text: 'Here is the report.' },
    ]
    const view = (holdFiles: boolean) => (
      <ContentViewProvider>
        <AssistantMessage message={{ id: 'm1', role: 'assistant', parts }} isStreaming={false} holdFiles={holdFiles} />
      </ContentViewProvider>
    )
    const { rerender } = render(view(true))
    await act(async () => void (await getClock().runAllAsync()))
    expect(screen.getByText('Here is the report.').closest('.animate-in')).toBeNull()

    rerender(view(false))
    await act(async () => void (await getClock().runAllAsync()))
    expect(screen.getByRole('button', { name: 'Download report.docx' })).toBeDefined()
    expect(screen.getByText('Here is the report.').closest('.animate-in')).toBeNull()
  })
})
