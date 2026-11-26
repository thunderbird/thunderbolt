/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock, spyOn } from 'bun:test'
import { filesAtPaths, httpLinks, readCopiedFiles } from './native-files'

const files = new Map([
  ['/home/ana/Q3 deck.pptx', 'deck'],
  ['/home/ana/Photo.JPG', 'photo'],
  ['/home/ana/notes', 'notes'],
  ['/home/ana/locked.docx', 'locked'],
])

const fakeFs = () => ({
  stat: mock(async (path: string) => {
    if (path === '/home/ana/Documents') {
      return { isFile: false, size: 4096 }
    }
    const content = files.get(path)
    if (content === undefined) {
      throw new Error(`forbidden path: ${path}`)
    }
    return { isFile: true, size: content.length }
  }),
  readFile: mock(async (path: string) => {
    if (path === '/home/ana/locked.docx') {
      throw new Error(`Permission denied: ${path}`)
    }
    return new TextEncoder().encode(files.get(path))
  }),
})

describe('filesAtPaths', () => {
  it('names and sizes each file from its path without reading it', async () => {
    const fs = fakeFs()
    const [deck] = await filesAtPaths(['/home/ana/Q3 deck.pptx'], fs)

    expect(deck).toMatchObject({ name: 'Q3 deck.pptx', size: 4 })
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  it('reads the bytes only when asked', async () => {
    const [deck] = await filesAtPaths(['/home/ana/Q3 deck.pptx'], fakeFs())
    const file = await deck.read()

    expect(file?.name).toBe('Q3 deck.pptx')
    expect(await file?.text()).toBe('deck')
  })

  it('types binary files by extension and leaves the rest for the name to resolve', async () => {
    const found = await filesAtPaths(['/home/ana/Photo.JPG', '/home/ana/Q3 deck.pptx', '/home/ana/notes'], fakeFs())

    expect(found.map((file) => file.type)).toEqual(['image/jpeg', '', ''])
  })

  it('leaves out folders and paths it cannot open', async () => {
    const found = await filesAtPaths(['/home/ana/Documents', '/dev/zero', '/home/ana/Photo.JPG'], fakeFs())

    expect(found.map((file) => file.name)).toEqual(['Photo.JPG'])
  })

  it('reads null for a file the OS refuses to read', async () => {
    const [locked] = await filesAtPaths(['/home/ana/locked.docx'], fakeFs())

    expect(locked.name).toBe('locked.docx')
    expect(await locked.read()).toBeNull()
  })
})

describe('readCopiedFiles', () => {
  const fakeCopied = () => ({
    list: mock(async () => [
      { path: '/home/ana/Photo.JPG', name: 'Photo.JPG', size: 5 },
      { path: '/home/ana/locked.docx', name: 'locked.docx', size: 6 },
    ]),
    read: mock(async (path: string) => {
      if (path === '/home/ana/locked.docx') {
        throw new Error(`Permission denied: ${path}`)
      }
      return new TextEncoder().encode('photo').buffer
    }),
  })

  it('lists the copied files without reading any', async () => {
    const native = fakeCopied()
    const copied = await readCopiedFiles(native)

    expect(copied.map(({ name, type, size }) => ({ name, type, size }))).toEqual([
      { name: 'Photo.JPG', type: 'image/jpeg', size: 5 },
      { name: 'locked.docx', type: '', size: 6 },
    ])
    expect(native.read).not.toHaveBeenCalled()
  })

  it('reads one file by its listed path when asked, and null when the read is refused', async () => {
    const native = fakeCopied()
    const [photo, locked] = await readCopiedFiles(native)
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})

    expect(await (await photo.read())?.text()).toBe('photo')
    expect(native.read).toHaveBeenCalledWith('/home/ana/Photo.JPG')
    expect(await locked.read()).toBeNull()
    consoleError.mockRestore()
  })
})

describe('httpLinks', () => {
  it('keeps only http and https URLs', () => {
    const uris = ['https://example.com/page?x=1', 'HTTP://example.com', 'file:///etc/passwd', '/home/ana/deck.pptx']

    expect(httpLinks([...uris, '# a uri-list comment', 'mailto:ana@example.com', ''])).toEqual(uris.slice(0, 2))
  })
})
