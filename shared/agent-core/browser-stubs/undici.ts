/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser stub for `undici`, aliased in `vite.config.ts` for the in-browser Pi
 * harness path.
 *
 * Why this exists: Pi's `core/http-dispatcher.js` does `import * as undici from
 * 'undici'` to install a custom Node HTTP dispatcher. `undici` is a Node-only
 * HTTP stack — its modules `extends` Node `stream`/`net`/`tls` classes at module
 * scope, throwing "Class extends value undefined" in the browser (those builtins
 * are externalized). The harness routes every model request through the app's
 * injected proxy `fetch`, never undici, so the whole library is dead weight here.
 *
 * Replacing it with this stub keeps undici's heavy Node graph out of the browser
 * bundle entirely. The dispatcher-config calls (`setGlobalDispatcher`, `install`,
 * `new EnvHttpProxyAgent(...)`) become harmless no-ops; `fetch` delegates to the
 * browser's native implementation in case anything reaches for it.
 */

/** No-op stand-in for undici's proxy agent — constructed but never used. */
class EnvHttpProxyAgent {}
class Agent {}
class ProxyAgent {}
class Pool {}

const setGlobalDispatcher = (): void => {}
const getGlobalDispatcher = (): undefined => undefined
const install = (): void => {}
const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => globalThis.fetch(input, init)

export { EnvHttpProxyAgent, Agent, ProxyAgent, Pool, setGlobalDispatcher, getGlobalDispatcher, install, fetch }

export default { EnvHttpProxyAgent, Agent, ProxyAgent, Pool, setGlobalDispatcher, getGlobalDispatcher, install, fetch }
