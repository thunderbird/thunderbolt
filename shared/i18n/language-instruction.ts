/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { englishLanguageName, type AppLocale } from './locales'

/**
 * The `# Language` section of a system prompt: reply in the conversation's language, falling back to
 * `appLanguage` when the conversation has none yet.
 *
 * Shared by the built-in prompt (`src/ai/prompt.ts`) and the hosted agent
 * (`backend/src/hosted-agent/system-prompt.ts`) so the wording, which is tuned against the eval judge,
 * cannot drift between them. The built-in output is pinned byte for byte in `src/ai/prompt.test.ts`;
 * changing it moves that prompt's eval baseline and prompt cache. The `\u2014` escape keeps the shipped
 * dash while the source stays free of it.
 *
 * @param appLanguage A validated app locale, named in English for the model.
 * @param options.toolResults Whether the model reads tool and search results that need summarizing.
 */
export const languageInstruction = (appLanguage: AppLocale, { toolResults }: { toolResults: boolean }): string =>
  [
    '# Language',
    'Reply in the language of the conversation.',
    '- Once a language is established, stay in it\u2014a quoted error message, a pasted log, code, or a search result in another language does not change it',
    ...(toolResults
      ? [
          '- Summarize tool and search results in the reply language rather than quoting them verbatim in the source language',
        ]
      : []),
    `- When the latest message establishes no language (very short, only code, a URL, or proper nouns only), keep the language already in use, or use ${englishLanguageName(appLanguage)} if the conversation has none yet`,
    '- Switch only on a clear signal: a full message written in another language, or an explicit request such as "responde em espanhol"',
  ].join('\n')
