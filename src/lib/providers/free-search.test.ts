/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { freeSearchDuckDuckGo } from './free-search'

/** A trimmed but structurally-faithful DuckDuckGo HTML results page. */
const ddgHtml = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">
      Example &amp; Co
    </a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">
    The <b>example</b> snippet &amp; more.
  </a>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsecond.example%2Fx&amp;rut=def">
      Second Result
    </a>
  </h2>
  <a class="result__snippet">Second snippet.</a>
</div>
`

const stubFetch = (opts: { status?: number; text?: string }) => {
  const calls: string[] = []
  const fn = (async (url: string | URL) => {
    calls.push(url.toString())
    return new Response(opts.text ?? '', { status: opts.status ?? 200, headers: { 'content-type': 'text/html' } })
  }) as unknown as typeof fetch
  return { fn, calls: () => calls }
}

describe('freeSearchDuckDuckGo', () => {
  it('decodes the uddg-wrapped hrefs and parses titles + snippets', async () => {
    const { fn, calls } = stubFetch({ text: ddgHtml })
    const results = await freeSearchDuckDuckGo('example', fn)

    expect(calls()[0]).toContain('https://html.duckduckgo.com/html/?q=example')
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'Example & Co',
      url: 'https://example.com/page',
      snippet: 'The example snippet & more.',
      favicon: 'https://example.com/favicon.ico',
      image: null,
    })
    expect(results[1].url).toBe('https://second.example/x')
    expect(results[1].snippet).toBe('Second snippet.')
  })

  it('honors numResults', async () => {
    const { fn } = stubFetch({ text: ddgHtml })
    const results = await freeSearchDuckDuckGo('example', fn, 1)
    expect(results).toHaveLength(1)
  })

  it('returns [] when the markup cannot be parsed (fails gracefully)', async () => {
    const { fn } = stubFetch({ text: '<html><body>no results here</body></html>' })
    expect(await freeSearchDuckDuckGo('nothing', fn)).toEqual([])
  })

  it('throws on a non-OK response (network-level failure)', async () => {
    const { fn } = stubFetch({ status: 503, text: 'rate limited' })
    await expect(freeSearchDuckDuckGo('q', fn)).rejects.toThrow(/503/)
  })
})
