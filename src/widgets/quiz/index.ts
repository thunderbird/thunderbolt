/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export { Quiz } from './display'
export { instructions } from './instructions'
export {
  collectQuizEntriesFromCache,
  formatQuizResultsNote,
  gradeQuiz,
  optionLetter,
  type QuizCacheEntry,
  type QuizData,
  type QuizMode,
  type QuizOption,
} from './lib'
export { parse, schema } from './schema'
export type { CacheData, QuizWidget } from './schema'
export { QuizWidget as Component } from './widget'
