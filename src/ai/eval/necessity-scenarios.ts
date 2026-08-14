/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { evalModels } from './scenarios'
import type { EvalCriteria, EvalScenario, NecessityCategory } from './types'

type NecessityPrompt = {
  id: string
  category: NecessityCategory
  prompt: string
  followUps?: string[]
  criteria: EvalCriteria
  isNegativeControl?: boolean
}

const reviewBy = '2026-11-04'
const noSearchCorrect: EvalCriteria = {
  mustProduceOutput: true,
  maxToolCalls: 0,
  expectCorrectAnswer: true,
}
const answerThenOffer: EvalCriteria = {
  mustProduceOutput: true,
  maxToolCalls: 0,
  expectSearchOffer: true,
}
const reusePriorResult: EvalCriteria = {
  mustProduceOutput: true,
  maxToolCalls: 0,
}
const searchOnce: EvalCriteria = {
  mustProduceOutput: true,
  minToolCalls: 1,
  maxToolCalls: 2,
  noDuplicateToolCalls: true,
}
const researchSearch: EvalCriteria = {
  mustProduceOutput: true,
  minToolCalls: 1,
  noDuplicateToolCalls: true,
}
const deepResearchSearch: EvalCriteria = {
  ...researchSearch,
  minToolCalls: 2,
}

const prompts: NecessityPrompt[] = [
  {
    id: 'never-search-01',
    category: 'never_search',
    prompt: 'Write a Python function that reverses a singly linked list.',
    criteria: noSearchCorrect,
  },
  {
    id: 'never-search-02',
    category: 'never_search',
    prompt: 'Show me an iterative Python implementation for reversing a linked list.',
    criteria: noSearchCorrect,
  },
  {
    id: 'never-search-03',
    category: 'never_search',
    prompt: 'How would you reverse a linked list in Python without allocating another list?',
    criteria: noSearchCorrect,
  },
  {
    id: 'never-search-04',
    category: 'never_search',
    prompt: 'Explain the practical differences between TCP and UDP.',
    criteria: noSearchCorrect,
  },
  {
    id: 'never-search-05',
    category: 'never_search',
    prompt: 'When should a networked application choose UDP instead of TCP?',
    criteria: noSearchCorrect,
  },
  {
    id: 'never-search-06',
    category: 'never_search',
    prompt: 'Compare TCP with UDP for reliability, ordering, and latency.',
    criteria: noSearchCorrect,
  },
  {
    id: 'never-search-07',
    category: 'never_search',
    prompt: 'What year did the Berlin Wall fall?',
    criteria: noSearchCorrect,
  },
  {
    id: 'never-search-08',
    category: 'never_search',
    prompt: 'In which year was the Berlin Wall opened?',
    criteria: noSearchCorrect,
  },
  {
    id: 'never-search-09',
    category: 'never_search',
    prompt: 'When did the fall of the Berlin Wall happen?',
    criteria: noSearchCorrect,
  },
  {
    id: 'never-search-10',
    category: 'never_search',
    prompt: 'What will $5,000 grow to at 4% annual compound interest after 7 years?',
    criteria: noSearchCorrect,
  },
  {
    id: 'never-search-11',
    category: 'never_search',
    prompt: 'Calculate the future value of $5,000 compounded annually at 4% for seven years.',
    criteria: noSearchCorrect,
  },
  {
    id: 'never-search-12',
    category: 'never_search',
    prompt: 'If I invest $5,000 at 4% compounded once per year, how much is there after year 7?',
    criteria: noSearchCorrect,
  },
  {
    id: 'answer-then-offer-01',
    category: 'answer_then_offer',
    prompt: 'Roughly how many people live in São Paulo?',
    criteria: answerThenOffer,
  },
  {
    id: 'answer-then-offer-02',
    category: 'answer_then_offer',
    prompt: 'Give me an approximate population for the city of São Paulo.',
    criteria: answerThenOffer,
  },
  {
    id: 'answer-then-offer-03',
    category: 'answer_then_offer',
    prompt: 'About what is São Paulo’s population?',
    criteria: answerThenOffer,
  },
  {
    id: 'answer-then-offer-04',
    category: 'answer_then_offer',
    prompt: 'Which countries can US citizens generally visit without arranging a visa in advance?',
    criteria: answerThenOffer,
  },
  {
    id: 'answer-then-offer-05',
    category: 'answer_then_offer',
    prompt: 'Summarize common visa-free destinations for an American passport holder.',
    criteria: answerThenOffer,
  },
  {
    id: 'answer-then-offer-06',
    category: 'answer_then_offer',
    prompt: 'Where can a US passport holder usually travel visa-free?',
    criteria: answerThenOffer,
  },
  {
    id: 'answer-then-offer-07',
    category: 'answer_then_offer',
    prompt: 'What are some UNESCO World Heritage sites in Italy?',
    criteria: answerThenOffer,
  },
  {
    id: 'answer-then-offer-08',
    category: 'answer_then_offer',
    prompt: 'Name several Italian sites on UNESCO’s World Heritage List.',
    criteria: answerThenOffer,
  },
  {
    id: 'answer-then-offer-09',
    category: 'answer_then_offer',
    prompt: 'Which major UNESCO-listed places can I visit in Italy?',
    criteria: answerThenOffer,
  },
  {
    id: 'answer-then-offer-10',
    category: 'answer_then_offer',
    prompt: 'Who is the CEO of Mozilla?',
    criteria: answerThenOffer,
  },
  {
    id: 'answer-then-offer-11',
    category: 'answer_then_offer',
    prompt: 'Can you tell me who currently leads Mozilla as CEO?',
    criteria: answerThenOffer,
  },
  {
    id: 'answer-then-offer-12',
    category: 'answer_then_offer',
    prompt: 'What is the name of Mozilla’s chief executive?',
    criteria: answerThenOffer,
  },
  {
    id: 'single-search-01',
    category: 'single_search',
    prompt: 'What is the current Bitcoin price?',
    criteria: searchOnce,
  },
  {
    id: 'single-search-02',
    category: 'single_search',
    prompt: 'How much is one bitcoin worth right now?',
    criteria: searchOnce,
  },
  {
    id: 'single-search-03',
    category: 'single_search',
    prompt: 'Give me today’s BTC price.',
    criteria: searchOnce,
  },
  {
    id: 'single-search-04',
    category: 'single_search',
    prompt: 'What is the weather in Lisbon right now?',
    criteria: searchOnce,
  },
  {
    id: 'single-search-05',
    category: 'single_search',
    prompt: 'Tell me Lisbon’s current temperature and conditions.',
    criteria: searchOnce,
  },
  {
    id: 'single-search-06',
    category: 'single_search',
    prompt: 'Is it raining in Lisbon at the moment?',
    criteria: searchOnce,
  },
  {
    id: 'single-search-07',
    category: 'single_search',
    prompt: 'What was the result of last night’s Champions League match?',
    criteria: searchOnce,
  },
  {
    id: 'single-search-08',
    category: 'single_search',
    prompt: 'Who won the Champions League game played last night?',
    criteria: searchOnce,
  },
  {
    id: 'single-search-09',
    category: 'single_search',
    prompt: 'Give me the score from yesterday evening’s Champions League fixture.',
    criteria: searchOnce,
  },
  {
    id: 'single-search-10',
    category: 'single_search',
    prompt: 'What is the latest stable Node.js version?',
    criteria: searchOnce,
  },
  {
    id: 'single-search-11',
    category: 'single_search',
    prompt: 'Which Node.js release is currently marked stable?',
    criteria: searchOnce,
  },
  {
    id: 'single-search-12',
    category: 'single_search',
    prompt: 'What version of Node should I install for the newest stable release?',
    criteria: searchOnce,
  },
  {
    id: 'research-01',
    category: 'research',
    prompt: 'Compare four-day work week trials in Iceland, Japan, and the UK, including measured outcomes.',
    criteria: researchSearch,
  },
  {
    id: 'research-02',
    category: 'research',
    prompt: 'Research how four-day work week pilots differed across Iceland, Japan, and Britain.',
    criteria: deepResearchSearch,
  },
  {
    id: 'research-03',
    category: 'research',
    prompt: 'Give me a comprehensive comparison of Icelandic, Japanese, and UK four-day-week trials.',
    criteria: deepResearchSearch,
  },
  {
    id: 'research-04',
    category: 'research',
    prompt: 'Compare solid-state battery startups and their stated 2026 commercialization timelines.',
    criteria: researchSearch,
  },
  {
    id: 'research-05',
    category: 'research',
    prompt: 'Research the leading solid-state battery startups and assess their 2026 milestones.',
    criteria: deepResearchSearch,
  },
  {
    id: 'research-06',
    category: 'research',
    prompt: 'Do a deep dive on solid-state battery companies and the credibility of their 2026 timelines.',
    criteria: deepResearchSearch,
  },
  {
    id: 'research-07',
    category: 'research',
    prompt: 'Compare facial-recognition regulation in the EU, United States, and China.',
    criteria: researchSearch,
  },
  {
    id: 'research-08',
    category: 'research',
    prompt: 'Research how EU, US, and Chinese rules govern facial recognition.',
    criteria: deepResearchSearch,
  },
  {
    id: 'research-09',
    category: 'research',
    prompt: 'Give me a comprehensive regulatory comparison of facial recognition in the EU, US, and China.',
    criteria: deepResearchSearch,
  },
  {
    id: 'research-10',
    category: 'research',
    prompt: 'Compare open-source Figma alternatives using current GitHub stars and latest release dates.',
    criteria: researchSearch,
  },
  {
    id: 'research-11',
    category: 'research',
    prompt: 'Research open-source alternatives to Figma, including GitHub popularity and release recency.',
    criteria: deepResearchSearch,
  },
  {
    id: 'research-12',
    category: 'research',
    prompt: 'Do a deep dive on open-source Figma competitors with current stars and latest releases.',
    criteria: deepResearchSearch,
  },
  {
    id: 'unknown-entity-01',
    category: 'unknown_entity',
    prompt: 'What is Tofes 17?',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-02',
    category: 'unknown_entity',
    prompt: 'Explain the term “Tofes 17” and where it is used.',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-03',
    category: 'unknown_entity',
    prompt: 'What does the “Zeus bridge” CLI do?',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-04',
    category: 'unknown_entity',
    prompt: 'What is the purpose of a CLI called Zeus bridge?',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-05',
    category: 'unknown_entity',
    prompt: 'What is in the Bun 1.4 release?',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-06',
    category: 'unknown_entity',
    prompt: 'Summarize the changes introduced by Bun 1.4.',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-07',
    category: 'unknown_entity',
    prompt: 'Who or what is Cluely?',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-08',
    category: 'unknown_entity',
    prompt: 'What does the company or product named Cluely do?',
    criteria: searchOnce,
  },
  {
    id: 'false-premise-01',
    category: 'false_premise',
    prompt: 'How long has Elon Musk been married to Grimes?',
    criteria: { ...searchOnce, maxToolCalls: 3, expectPremiseRebuttal: true },
  },
  {
    id: 'false-premise-02',
    category: 'false_premise',
    prompt: 'Why did Mozilla discontinue Thunderbird in 2024?',
    criteria: { ...searchOnce, maxToolCalls: 3, expectPremiseRebuttal: true },
  },
  {
    id: 'false-premise-03',
    category: 'false_premise',
    prompt: 'When did Portugal leave the European Union?',
    criteria: { ...searchOnce, maxToolCalls: 3, expectPremiseRebuttal: true },
  },
  {
    id: 'false-premise-04',
    category: 'false_premise',
    prompt: 'What caused Canada to adopt the euro in 2022?',
    criteria: { ...searchOnce, maxToolCalls: 3, expectPremiseRebuttal: true },
  },
  {
    id: 'false-premise-05',
    category: 'false_premise',
    prompt: 'Why was Python renamed Monty in version 4.0?',
    criteria: { ...searchOnce, maxToolCalls: 3, expectPremiseRebuttal: true },
  },
  {
    id: 'false-premise-06',
    category: 'false_premise',
    prompt: 'When did Australia move its capital from Canberra to Sydney?',
    criteria: { ...searchOnce, maxToolCalls: 3, expectPremiseRebuttal: true },
  },
  {
    id: 'false-premise-07',
    category: 'false_premise',
    prompt: 'Why did the World Health Organization ban coffee in 2025?',
    criteria: { ...searchOnce, maxToolCalls: 3, expectPremiseRebuttal: true },
  },
  {
    id: 'false-premise-08',
    category: 'false_premise',
    prompt: 'How did Apple’s 2023 acquisition of Microsoft change Windows?',
    criteria: { ...searchOnce, maxToolCalls: 3, expectPremiseRebuttal: true },
  },
  {
    id: 'adversarial-no-search-01',
    category: 'adversarial_no_search',
    prompt: 'Search your memory — what is the boiling point of water at sea level?',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-02',
    category: 'adversarial_no_search',
    prompt: 'What is the latest thinking on why the sky is blue?',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-03',
    category: 'adversarial_no_search',
    prompt: 'Look up in your knowledge how many sides a hexagon has.',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-04',
    category: 'adversarial_no_search',
    prompt: 'Find the definitive formula for the area of a circle.',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-05',
    category: 'adversarial_no_search',
    prompt: 'What is the current capital of Australia?',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-06',
    category: 'adversarial_no_search',
    prompt: 'As of today, how many continents are there?',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-07',
    category: 'adversarial_no_search',
    prompt: 'Right now, what is the chemical symbol for gold?',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-08',
    category: 'adversarial_no_search',
    prompt: 'At present, which planet is closest to the Sun?',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-09',
    category: 'adversarial_no_search',
    prompt: 'When did Freddie Mercury die?',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-10',
    category: 'adversarial_no_search',
    prompt: 'What was the last Beatles studio album?',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-11',
    category: 'adversarial_no_search',
    prompt: 'Who won the 1966 FIFA World Cup?',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-12',
    category: 'adversarial_no_search',
    prompt: 'Which Apollo mission first landed humans on the Moon?',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-13',
    category: 'adversarial_no_search',
    prompt: 'Write me a haiku about deadlines.',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-14',
    category: 'adversarial_no_search',
    prompt: 'Refactor this JavaScript function: const double = (items) => items.map((item) => item * 2)',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-15',
    category: 'adversarial_no_search',
    prompt: 'Summarize this message: “The meeting moved from Tuesday morning to Thursday afternoon.”',
    criteria: noSearchCorrect,
  },
  {
    id: 'adversarial-no-search-16',
    category: 'adversarial_no_search',
    prompt: 'Give me three friendly names for a neighborhood book club.',
    criteria: noSearchCorrect,
  },
  {
    id: 'multi-turn-reuse-01',
    category: 'multi_turn_reuse',
    prompt: 'What is the current Bitcoin price in US dollars?',
    followUps: ['Repeat the price you just found, rounded to the nearest dollar.'],
    criteria: reusePriorResult,
  },
  {
    id: 'multi-turn-reuse-02',
    category: 'multi_turn_reuse',
    prompt: 'What is the weather in Lisbon right now, including wind speed?',
    followUps: ['What wind speed did you find?'],
    criteria: reusePriorResult,
  },
  {
    id: 'multi-turn-reuse-03',
    category: 'multi_turn_reuse',
    prompt: 'What is the latest stable Node.js version and its release date?',
    followUps: ['What release date did you just give me?'],
    criteria: reusePriorResult,
  },
  {
    id: 'multi-turn-reuse-04',
    category: 'multi_turn_reuse',
    prompt: 'Give me the score and goal scorers from the latest completed Champions League match.',
    followUps: ['Who were the scorers in that match?'],
    criteria: reusePriorResult,
  },
  {
    id: 'multi-turn-reuse-05',
    category: 'multi_turn_reuse',
    prompt: 'What is React’s latest GitHub release and when was it published?',
    followUps: ['Remind me of that release tag.'],
    criteria: reusePriorResult,
  },
  {
    id: 'multi-turn-reuse-06',
    category: 'multi_turn_reuse',
    prompt: 'What was NASA’s most recent launch, and where did it launch from?',
    followUps: ['Which launch site was that?'],
    criteria: reusePriorResult,
  },
  {
    id: 'multi-turn-reuse-07',
    category: 'multi_turn_reuse',
    prompt: 'How did the S&P 500 close today, including its percentage move?',
    followUps: ['What percentage move did you report?'],
    criteria: reusePriorResult,
  },
  {
    id: 'multi-turn-reuse-08',
    category: 'multi_turn_reuse',
    prompt: 'What is the newest stable Bun release and its release date?',
    followUps: ['Tell me that version number again.'],
    criteria: reusePriorResult,
  },
  {
    id: 'multi-turn-reuse-09',
    category: 'multi_turn_reuse',
    prompt: 'What is Mozilla Firefox’s latest stable release number?',
    followUps: ['Repeat the number without looking it up again.'],
    criteria: reusePriorResult,
  },
  {
    id: 'multi-turn-reuse-10',
    category: 'multi_turn_reuse',
    prompt: 'Who won the latest Formula 1 race, and what team do they drive for?',
    followUps: ['Which team did you say?'],
    criteria: reusePriorResult,
  },
  {
    id: 'multi-turn-reuse-11',
    category: 'multi_turn_reuse',
    prompt: 'What is the current price of gold per ounce?',
    followUps: ['And what is the current price of silver per ounce?'],
    criteria: searchOnce,
    isNegativeControl: true,
  },
  {
    id: 'multi-turn-reuse-12',
    category: 'multi_turn_reuse',
    prompt: 'What is the weather in Lisbon right now?',
    followUps: ['And what is the weather in Porto right now?'],
    criteria: searchOnce,
    isNegativeControl: true,
  },
  {
    id: 'search-wont-help-01',
    category: 'search_wont_help',
    prompt: 'What exact number am I thinking of right now?',
    criteria: { mustProduceOutput: true, maxToolCalls: 2, expectVerificationDisclaimer: true },
  },
  {
    id: 'search-wont-help-02',
    category: 'search_wont_help',
    prompt: 'Will my private job interview next Tuesday result in an offer?',
    criteria: { mustProduceOutput: true, maxToolCalls: 2, expectVerificationDisclaimer: true },
  },
  {
    id: 'search-wont-help-03',
    category: 'search_wont_help',
    prompt: 'Did my neighbor leave home ten minutes ago?',
    criteria: { mustProduceOutput: true, maxToolCalls: 2, expectVerificationDisclaimer: true },
  },
  {
    id: 'search-wont-help-04',
    category: 'search_wont_help',
    prompt: 'Which unpublished novel will win the 2030 Booker Prize?',
    criteria: { mustProduceOutput: true, maxToolCalls: 2, expectVerificationDisclaimer: true },
  },
]

/** Build the search-necessity matrix, optionally including the noisier verification scenarios. */
export const getNecessityScenarios = (
  modelNames?: string[],
  engineNames?: string[],
  includeOptional = process.env.EVAL_NECESSITY_OPTIONAL === '1',
): EvalScenario[] =>
  evalModels
    .filter(
      ({ name, engineName }) =>
        (!modelNames || modelNames.includes(name)) && (!engineNames || engineNames.includes(engineName)),
    )
    .flatMap((model) =>
      prompts
        .filter(({ category }) => includeOptional || category !== 'search_wont_help')
        .map((definition) => ({
          id: `${model.name}/${model.engineName}/chat/${definition.id}`,
          modelName: model.name,
          engineName: model.engineName,
          modeName: 'chat',
          prompt: definition.prompt,
          followUps: definition.followUps,
          criteria: definition.criteria,
          category: definition.category,
          reviewBy,
          isNegativeControl: definition.isNegativeControl,
        })),
    )
