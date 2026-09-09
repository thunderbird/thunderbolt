/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getActiveLocale } from '@/i18n/active-locale'
import type { AppLocale } from '@shared/i18n/locales'
import { evalModels } from './scenarios'
import type { EvalScenario } from './types'

/**
 * Reply-language scenarios for the `# Language` section of the system prompt.
 *
 * Each one maps to a single claim the prompt makes, so a failure names the clause
 * that broke rather than "the model answered in the wrong language":
 *
 * - the conversation's language beats the app setting
 * - it is sticky against foreign-language content pasted or searched mid-thread
 * - an explicit request still switches it
 * - a turn that establishes no language falls back to the app setting
 * - none of the above fires on an ordinary English thread
 *
 * The app language is process-global (`setActiveLocale`), and scenarios run
 * concurrently, so it is a property of the *run* rather than of a scenario. That is
 * why the fallback scenarios assert against whatever the run resolved: with the
 * default `en` they check that a signal-free turn does not drift, and under
 * `EVAL_LANGUAGE=ja` they check the fallback actually reaches the setting. Every
 * other scenario states its expected language outright and holds either way.
 */
type LanguagePrompt = {
  id: string
  prompt: string
  followUps?: string[]
  /** Omitted where the expectation is the run's app language rather than a fixed one. */
  expectReplyLanguage?: AppLocale
  /** Set where the turn must actually reach the web, so English sources are in play. */
  minToolCalls?: number
  /** Guards against a prompt that spends Chat's two-call budget on searches. */
  maxToolCalls?: number
  isNegativeControl?: boolean
}

const reviewBy = '2026-11-04'

/** An English stack trace, pasted verbatim into a Portuguese thread. */
const englishStackTrace = `Traceback (most recent call last):
  File "app.py", line 42, in <module>
    main()
  File "app.py", line 31, in main
    total = sum(row["amount"] for row in rows)
KeyError: 'amount'`

const prompts: LanguagePrompt[] = [
  {
    id: 'language-establish-01',
    prompt: 'Me explica o que é um mutex e quando eu deveria usar um.',
    expectReplyLanguage: 'pt-BR',
  },
  {
    id: 'language-establish-02',
    prompt: 'ミューテックスとは何か、どんなときに使うべきか教えてください。',
    expectReplyLanguage: 'ja',
  },
  {
    // The regression the prompt's stickiness clause exists for: an English paste
    // must not flip an established Portuguese thread.
    id: 'language-sticky-paste-01',
    prompt: 'Estou com um erro no meu script Python e não entendo o motivo.',
    followUps: [`O que significa isso?\n\n${englishStackTrace}`],
    expectReplyLanguage: 'pt-BR',
  },
  {
    // English search results are the other way a non-English thread flips. Kept to a
    // single-fact question on purpose: Chat's `auto` web budget is two calls, and a
    // multi-angle prompt ("what's new in X") spends it on searches and ends the turn
    // with no prose at all — which measures the budget rather than the language.
    id: 'language-sticky-search-01',
    prompt: 'Qual é a cotação atual do Bitcoin?',
    expectReplyLanguage: 'pt-BR',
    minToolCalls: 1,
    maxToolCalls: 2,
  },
  {
    id: 'language-explicit-switch-01',
    prompt: 'Me explica a diferença entre TCP e UDP.',
    followUps: ['From now on, answer me in English. Which one should I pick for a video call app?'],
    expectReplyLanguage: 'en',
  },
  {
    // Bare code establishes nothing, so the reply falls back to the app language.
    id: 'language-fallback-code-01',
    prompt: 'def f(xs):\n    return [x * 2 for x in xs if x % 2 == 0]',
  },
  {
    // Neither does a message this short.
    id: 'language-fallback-terse-01',
    prompt: 'hm?',
  },
  {
    // Guards the failure mode of a language directive: over-triggering.
    id: 'language-negative-control-01',
    prompt: 'Explain the practical differences between a hash map and a binary search tree.',
    expectReplyLanguage: 'en',
    isNegativeControl: true,
  },
]

/**
 * Build the reply-language suite across the model/engine matrix.
 *
 * @param modelNames Restrict to these eval model names; all models when omitted.
 * @param engineNames Restrict to these engines; all engines when omitted.
 * @param appLanguage The run's resolved app language, used by the fallback scenarios.
 */
export const getLanguageScenarios = (
  modelNames?: string[],
  engineNames?: string[],
  appLanguage: AppLocale = getActiveLocale(),
): EvalScenario[] =>
  evalModels
    .filter(
      ({ name, engineName }) =>
        (!modelNames || modelNames.includes(name)) && (!engineNames || engineNames.includes(engineName)),
    )
    .flatMap((model) =>
      prompts.map((definition) => ({
        id: `${model.name}/${model.engineName}/chat/${definition.id}`,
        modelName: model.name,
        engineName: model.engineName,
        modeName: 'chat' as const,
        prompt: definition.prompt,
        followUps: definition.followUps,
        criteria: {
          mustProduceOutput: true,
          expectReplyLanguage: definition.expectReplyLanguage ?? appLanguage,
          ...(definition.minToolCalls === undefined ? {} : { minToolCalls: definition.minToolCalls }),
          ...(definition.maxToolCalls === undefined ? {} : { maxToolCalls: definition.maxToolCalls }),
        },
        category: 'language' as const,
        reviewBy,
        isNegativeControl: definition.isNegativeControl,
      })),
    )
