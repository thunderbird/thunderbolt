/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Evaluated inside the sandbox VM, never imported by the app: gives a script the zip and XML libraries it
 * needs to edit the parts of an Office file directly. Bundled into one script by `?sandbox-script`.
 */
import * as xmldom from '@xmldom/xmldom'
import * as fflate from 'fflate'

Object.assign(globalThis, { fflate, xmldom })
