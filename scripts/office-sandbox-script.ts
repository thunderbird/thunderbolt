/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Plugin } from 'vite'
import { bundleSandboxScript } from '../src/office/bundle-sandbox-script'

const query = '?sandbox-script'

/** `import code from './entry.ts?sandbox-script'` gives the module bundled into one classic script, as a string. */
export const officeSandboxScriptPlugin = (): Plugin => ({
  name: 'office-sandbox-script',
  async load(id) {
    const [entry, search] = id.split('?')
    if (`?${search}` !== query) {
      return null
    }
    this.addWatchFile(entry)
    return `export default ${JSON.stringify(await bundleSandboxScript(entry))}`
  },
})
