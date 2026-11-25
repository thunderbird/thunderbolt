/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * System WebKit on macOS 26.4 and iOS 26.5 has no `Symbol.dispose`. quickjs-wasi uses it as a class
 * method key and in every error path, so without it each interrupt, syntax error and host-function
 * throw becomes `TypeError: Symbol.dispose is not defined`. Import this module before quickjs-wasi.
 */
const symbols: { dispose?: symbol; asyncDispose?: symbol } = Symbol
symbols.dispose ??= Symbol.for('Symbol.dispose')
symbols.asyncDispose ??= Symbol.for('Symbol.asyncDispose')
