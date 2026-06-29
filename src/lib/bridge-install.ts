/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke } from '@tauri-apps/api/core'

/**
 * Runs the desktop bridge installer — the Rust `install_bridge` command, which
 * executes `cli/install.sh` through a login shell and drops the `thunderbolt` binary on
 * the user's PATH. Resolves with the installer's stdout, rejects with its error
 * message. Desktop only; callers gate on `isDesktop()`.
 */
export const installBridge = (): Promise<string> => invoke<string>('install_bridge')
