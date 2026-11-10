/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { actionFromInput, actionSchema } from './action-schema'

const parse = (input: unknown) => actionFromInput(actionSchema.parse(input))

it.each([
  [
    { type: 'click', ref: 'doc:1', button: 'right' },
    { type: 'click', ref: 'doc:1', button: 'right' },
  ],
  [
    { type: 'click', x: 0, y: 0 },
    { type: 'click', x: 0, y: 0 },
  ],
  [
    { type: 'move', ref: 'doc:1', button: 'left' },
    { type: 'move', ref: 'doc:1' },
  ],
  [
    { type: 'move', x: 50, y: 60 },
    { type: 'move', x: 50, y: 60 },
  ],
  [
    { type: 'type', text: '', clear: true, ref: 'doc:1' },
    { type: 'type', text: '', clear: true, ref: 'doc:1' },
  ],
  [
    { type: 'key', key: 'Control+a' },
    { type: 'key', key: 'Control+a' },
  ],
  [
    { type: 'scroll', deltaY: 0, deltaX: -100 },
    { type: 'scroll', deltaY: 0, deltaX: -100 },
  ],
  [
    { type: 'scroll', x: 20, y: 30, deltaY: 250 },
    { type: 'scroll', x: 20, y: 30, deltaY: 250 },
  ],
])('constructs the requested action without passing unrelated tool fields (%j)', (input, expected) => {
  expect(parse({ tabId: 'tab', ...input })).toMatchObject(expected)
  expect(parse({ tabId: 'tab', ...input })).not.toHaveProperty('tabId')
})

it.each([
  { type: 'click' },
  { type: 'move' },
  { type: 'click', x: 10 },
  { type: 'click', y: 10 },
  { type: 'click', ref: 'doc:1', x: 10, y: 10 },
  { type: 'move', x: -1, y: 10 },
  { type: 'move', x: Infinity, y: 10 },
  { type: 'click', x: NaN, y: 10 },
  { type: 'type' },
  { type: 'type', text: 'x'.repeat(20_001) },
  { type: 'key' },
  { type: 'key', key: '' },
  { type: 'scroll' },
  { type: 'scroll', deltaY: 100_001 },
  { type: 'scroll', deltaY: -100_001 },
  { type: 'click', ref: '' },
])('rejects incomplete or out-of-range input (%j)', (input) => {
  expect(() => parse({ tabId: 'tab', ...input })).toThrow()
})
