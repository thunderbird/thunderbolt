/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { workspacePageId } from './workspace-page-id'

it('normalizes aliases within a workspace without conflating owners, environments, or files', () => {
  const id = workspacePageId('chat-a:sandbox', '/workspace', 'app.html')
  expect(workspacePageId('chat-a:sandbox', '/workspace', './dir/../app.html')).toBe(id)
  expect(workspacePageId('chat-a:sandbox', '/workspace', '/workspace/app.html')).toBe(id)
  expect(workspacePageId('chat-b:sandbox', '/workspace', 'app.html')).not.toBe(id)
  expect(workspacePageId('chat-a:ssh-host', '/workspace', 'app.html')).not.toBe(id)
  expect(workspacePageId('chat-a:sandbox', '/other', 'app.html')).not.toBe(id)
  expect(workspacePageId('chat-a:sandbox', '/workspace', 'other.html')).not.toBe(id)
  expect(workspacePageId('chat-a:sandbox', '/workspace', 'dir\\app.html')).not.toBe(
    workspacePageId('chat-a:sandbox', '/workspace', 'dir/app.html'),
  )
})

it('normalizes Windows separators and absolute paths', () => {
  expect(workspacePageId('computer', 'C:\\project', '.\\site\\..\\app.html')).toBe(
    workspacePageId('computer', 'C:\\project', 'C:/project/app.html'),
  )
})
