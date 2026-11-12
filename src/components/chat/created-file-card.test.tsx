/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ContentViewProvider } from '@/content-view/context'
import { docxMime, pptxMime } from '@/files/transformers'
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
const bytes = new Uint8Array([80, 75, 3, 4])
const storedFiles = [report, deck].map((file) => ({
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

  it('shows why a download failed', async () => {
    downloadFile.mockRejectedValue(new Error('No space left on device'))
    await renderMessage(finishedCall({ ok: true, files: [report], logs: '' }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download report.docx' }))
      await getClock().runAllAsync()
    })
    expect(screen.getByText("Couldn't save: No space left on device")).toBeDefined()
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
})
