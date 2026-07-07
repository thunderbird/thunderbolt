/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The `css-tree/parser` subpath (the lean, parse-only entry — no lexer / mdn-data) ships
// no types of its own. Its default export is the same `parse` function as the css-tree
// root, so borrow that type from `@types/css-tree`.
declare module 'css-tree/parser' {
  const parse: typeof import('css-tree').parse
  export default parse
}
