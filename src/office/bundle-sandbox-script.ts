/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { build, type Rolldown } from 'vite'

/**
 * Bundle a module and its dependencies into one classic script. The Office sandbox VM has no module loader,
 * and some of its libraries ship only as CommonJS files. Only build tooling calls this, never the app: the Vite
 * plugin in `scripts/office-sandbox-script.ts` and the sandbox tests both build the VM's script with it.
 */
export const bundleSandboxScript = async (entry: string): Promise<string> => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: { write: false, minify: true, lib: { entry, formats: ['iife'], name: 'sandboxScript' } },
  })
  // `write: false` without `watch` resolves to one output.
  const [{ output }] = [result].flat() as Rolldown.RolldownOutput[]
  return output[0].code
}
