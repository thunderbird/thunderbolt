/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { loadOtariSearchStatus, loadOtariWebCapabilities } from './capabilities'

afterEach(() => mock.restore())

it.each(['available', 'not_configured', 'workspace_disabled', 'unknown'] as const)(
  'discovers page fetching separately from search: %s',
  async (status) => {
    spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        data: [
          { id: 'otari_web_search', available: true, direct_available: true },
          ...(status === 'unknown'
            ? []
            : [
                {
                  id: 'otari_web_fetch',
                  available: status === 'available',
                  direct_available: status === 'available',
                  reason: status === 'available' ? null : status,
                },
              ]),
        ],
      }),
    )
    expect(await loadOtariWebCapabilities('https://otari.example/api/v1', 'key', new AbortController().signal)).toEqual(
      {
        search: 'available',
        fetch: status,
      },
    )
  },
)

it.each(['available', 'not_configured', 'workspace_disabled'] as const)(
  'reads workspace search availability: %s',
  async (status) => {
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        data: [
          {
            id: 'otari_web_search',
            available: status === 'available',
            direct_available: status === 'available',
            reason: status === 'available' ? null : status,
          },
        ],
      }),
    )
    expect(await loadOtariSearchStatus('https://otari.example/api/v1', 'key', new AbortController().signal)).toBe(
      status,
    )
    const request = new Request(fetch.mock.calls[0][0])
    expect(request.method).toBe('GET')
    expect(request.url).toBe('https://otari.example/api/v1/tools')
    expect(request.headers.get('Authorization')).toBe('Bearer key')
    expect(request.credentials).toBe('omit')
    expect(request.redirect).toBe('error')
  },
)

it.each([Response.json({ data: [] }), Response.json({ invalid: true }), new Response('', { status: 404 })])(
  'does not assume search exists after an unknown or incompatible discovery response',
  async (response) => {
    spyOn(globalThis, 'fetch').mockResolvedValue(response)
    expect(await loadOtariSearchStatus('https://otari.example/api/v1', 'key', new AbortController().signal)).toBe(
      'unknown',
    )
  },
)

it('ignores new tool reasons without disabling independent supported capabilities', async () => {
  spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      data: [
        { id: 'otari_web_search', available: true, direct_available: true },
        { id: 'otari_web_fetch', available: false, direct_available: false, reason: 'temporarily_unavailable' },
        { id: 'future_tool', available: false, reason: 'upgrade_required' },
      ],
    }),
  )
  expect(await loadOtariWebCapabilities('https://otari.example/api/v1', 'key', new AbortController().signal)).toEqual({
    search: 'available',
    fetch: 'unknown',
  })
})

it.each([undefined, null, false])(
  'never infers direct search from in-model availability (%s)',
  async (direct_available) => {
    spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        data: [
          { id: 'otari_web_search', available: true, direct_available },
          { id: 'otari_web_fetch', available: true, direct_available: true },
        ],
      }),
    )
    expect(await loadOtariWebCapabilities('https://otari.example/api/v1', 'key', new AbortController().signal)).toEqual(
      {
        search: 'unknown',
        fetch: 'available',
      },
    )
  },
)

it('honors direct-only tools without relying on in-model availability or its reason', async () => {
  spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      data: [
        { id: 'otari_web_search', available: false, direct_available: true, reason: 'not_configured' },
        { id: 'otari_web_fetch', available: true, direct_available: false, reason: null },
      ],
    }),
  )
  expect(await loadOtariWebCapabilities('https://otari.example/api/v1', 'key', new AbortController().signal)).toEqual({
    search: 'available',
    fetch: 'unknown',
  })
})

it('treats legacy discovery as unknown even if its in-model reason is recognized', async () => {
  spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      data: [{ id: 'otari_web_search', available: false, reason: 'not_configured' }],
    }),
  )
  expect(await loadOtariSearchStatus('https://otari.example/api/v1', 'key', new AbortController().signal)).toBe(
    'unknown',
  )
})

it('propagates cancellation instead of persisting it as an unavailable workspace', async () => {
  const controller = new AbortController()
  controller.abort(new DOMException('Canceled', 'AbortError'))
  const fetch = spyOn(globalThis, 'fetch')
  await expect(loadOtariSearchStatus('https://otari.example/api/v1', 'key', controller.signal)).rejects.toThrow(
    'Canceled',
  )
  expect(fetch).not.toHaveBeenCalled()
})
