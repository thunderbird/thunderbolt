/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { createParser } from './create-parser'

describe('createParser', () => {
  it('creates a parser that validates and constructs widget objects', () => {
    const schema = z.object({
      widget: z.literal('test-widget'),
      args: z.object({
        foo: z.string().min(1),
        bar: z.string().min(1),
      }),
    })

    const parse = createParser(schema)

    const result = parse({ foo: 'hello', bar: 'world' })

    expect(result).toEqual({
      widget: 'test-widget',
      args: {
        foo: 'hello',
        bar: 'world',
      },
    })
  })

  it('returns null when required attributes are missing', () => {
    const schema = z.object({
      widget: z.literal('test-widget'),
      args: z.object({
        foo: z.string().min(1),
        bar: z.string().min(1),
      }),
    })

    const parse = createParser(schema)

    expect(parse({ foo: 'hello' })).toBeNull()
    expect(parse({ bar: 'world' })).toBeNull()
    expect(parse({})).toBeNull()
  })

  it('returns null when attributes are empty strings', () => {
    const schema = z.object({
      widget: z.literal('test-widget'),
      args: z.object({
        foo: z.string().min(1),
      }),
    })

    const parse = createParser(schema)

    expect(parse({ foo: '' })).toBeNull()
  })

  it('validates using zod schema rules', () => {
    const schema = z.object({
      widget: z.literal('test-widget'),
      args: z.object({
        url: z.string().url('Invalid URL'),
        count: z.string().regex(/^\d+$/, 'Must be a number'),
      }),
    })

    const parse = createParser(schema)

    // Valid
    expect(parse({ url: 'https://example.com', count: '42' })).toEqual({
      widget: 'test-widget',
      args: {
        url: 'https://example.com',
        count: '42',
      },
    })

    // Invalid URL
    expect(parse({ url: 'not a url', count: '42' })).toBeNull()

    // Invalid count
    expect(parse({ url: 'https://example.com', count: 'abc' })).toBeNull()
  })

  it('handles schemas with single argument', () => {
    const schema = z.object({
      widget: z.literal('simple-widget'),
      args: z.object({
        value: z.string().min(1),
      }),
    })

    const parse = createParser(schema)

    expect(parse({ value: 'test' })).toEqual({
      widget: 'simple-widget',
      args: {
        value: 'test',
      },
    })

    expect(parse({ value: '' })).toBeNull()
    expect(parse({})).toBeNull()
  })

  it('handles schemas with many arguments', () => {
    const schema = z.object({
      widget: z.literal('complex-widget'),
      args: z.object({
        a: z.string().min(1),
        b: z.string().min(1),
        c: z.string().min(1),
        d: z.string().min(1),
      }),
    })

    const parse = createParser(schema)

    expect(parse({ a: '1', b: '2', c: '3', d: '4' })).toEqual({
      widget: 'complex-widget',
      args: {
        a: '1',
        b: '2',
        c: '3',
        d: '4',
      },
    })

    // Missing any argument should fail
    expect(parse({ a: '1', b: '2', c: '3' })).toBeNull()
  })

  it('ignores extra attributes not in schema', () => {
    const schema = z.object({
      widget: z.literal('test-widget'),
      args: z.object({
        foo: z.string().min(1),
      }),
    })

    const parse = createParser(schema)

    // Extra attributes are ignored
    expect(parse({ foo: 'hello', extra: 'ignored' })).toEqual({
      widget: 'test-widget',
      args: {
        foo: 'hello',
      },
    })
  })
})
