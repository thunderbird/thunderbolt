/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export { Ask } from './display'
export { instructions } from './instructions'
export {
  collectAskEntriesFromCache,
  evaluateAnswer,
  formatAskResponsesNote,
  optionLetter,
  type AskCacheEntry,
  type AskData,
  type AskMode,
  type AskOption,
} from './lib'
export { parse, schema } from './schema'
export type { AskWidget, CacheData } from './schema'
export { AskWidget as Component } from './widget'
