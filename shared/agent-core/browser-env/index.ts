/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser execution environment for the Pi harness: a single ZenFS mount shared
 * between Pi's filesystem API and just-bash's shell, presenting OPFS as a CLI,
 * plus the per-tool operation adapters that bind Pi's four coding tools to it.
 */

export { BrowserExecutionEnv } from './browser-execution-env.ts'
export { ZenBashFileSystem } from './zen-bash-fs.ts'
export { mountAgentFs, mountInMemoryFs, type MountedBackend } from './mount.ts'
export {
  createBashOperations,
  createEditOperations,
  createReadOperations,
  createWriteOperations,
} from './coding-tool-operations.ts'
