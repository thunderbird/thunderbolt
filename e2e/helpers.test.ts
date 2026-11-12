/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { Page } from '@playwright/test'
import { collectPageErrors } from './helpers'

const abortedImport = 'Importing a module script failed.'

/** A page that only emits the events `collectPageErrors` listens to. */
const createFakePage = () => {
  const events = new EventEmitter()
  const mainFrame = {}
  const childFrame = {}
  const request = (frame: object, isNavigation = true) => ({
    isNavigationRequest: () => isNavigation,
    frame: () => frame,
  })
  const page = Object.assign(events, { mainFrame: () => mainFrame }) as unknown as Page
  return {
    page,
    navigate: () => events.emit('request', request(mainFrame)),
    navigateChildFrame: () => events.emit('request', request(childFrame)),
    fetch: () => events.emit('request', request(mainFrame, false)),
    failNavigation: () => events.emit('requestfailed', request(mainFrame)),
    load: () => events.emit('domcontentloaded'),
    throwError: (message: string) => events.emit('pageerror', new Error(message)),
  }
}

test('ignores an aborted import while the main frame navigates', () => {
  const fake = createFakePage()
  const errors = collectPageErrors(fake.page)
  fake.navigate()
  fake.throwError(abortedImport)
  expect(errors).toEqual([])
})

test('records an aborted import outside a navigation', () => {
  const fake = createFakePage()
  const errors = collectPageErrors(fake.page)
  fake.throwError(abortedImport)
  fake.fetch()
  fake.throwError(abortedImport)
  expect(errors).toEqual([abortedImport, abortedImport])
})

test('records an aborted import once the new document has loaded', () => {
  const fake = createFakePage()
  const errors = collectPageErrors(fake.page)
  fake.navigate()
  fake.load()
  fake.throwError(abortedImport)
  expect(errors).toEqual([abortedImport])
})

test('records an aborted import after the navigation request fails', () => {
  const fake = createFakePage()
  const errors = collectPageErrors(fake.page)
  fake.navigate()
  fake.failNavigation()
  fake.throwError(abortedImport)
  expect(errors).toEqual([abortedImport])
})

test('records an aborted import during an iframe navigation', () => {
  const fake = createFakePage()
  const errors = collectPageErrors(fake.page)
  fake.navigateChildFrame()
  fake.throwError(abortedImport)
  expect(errors).toEqual([abortedImport])
})

test('records other errors during a navigation', () => {
  const fake = createFakePage()
  const errors = collectPageErrors(fake.page)
  fake.navigate()
  fake.throwError('Cannot read properties of undefined')
  expect(errors).toEqual(['Cannot read properties of undefined'])
})
