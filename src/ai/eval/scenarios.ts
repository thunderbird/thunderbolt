/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModelGptOss120b, defaultModelMistralMedium31, defaultModelSonnet45 } from '@/defaults/models'
import type { EvalCriteria, EvalScenario } from './types'

const models = [
  { name: 'gpt-oss', id: defaultModelGptOss120b.id },
  { name: 'mistral', id: defaultModelMistralMedium31.id },
  { name: 'sonnet', id: defaultModelSonnet45.id },
] as const

/** Default criteria applied to all Chat mode scenarios */
const chatCriteria: EvalCriteria = {
  mustProduceOutput: true,
  minCitations: 1,
  noReviewSites: true,
}

/** Default criteria applied to all Search mode scenarios */
const searchCriteria: EvalCriteria = {
  mustProduceOutput: true,
  mustUseLinkPreviews: true,
  noHomepageLinks: true,
}

/** Default criteria applied to all Research mode scenarios */
const researchCriteria: EvalCriteria = {
  mustProduceOutput: true,
  minCitations: 3,
}

// ──────────────────────────────────────────────
// Chat Mode Prompts (15)
// ──────────────────────────────────────────────

const chatPrompts = [
  { id: 'C1', prompt: 'What are the top 3 news stories today?' },
  {
    id: 'C2',
    prompt: 'Best robot vacuums to buy right now',
    criteria: { ...chatCriteria, noHomepageLinks: true, noReviewSites: false },
  },
  { id: 'C3', prompt: "What's the current price of Bitcoin?" },
  {
    id: 'C4',
    prompt: 'Compare the iPhone 16 Pro and Samsung Galaxy S25 Ultra',
    criteria: { ...chatCriteria, minCitations: 2 },
  },
  { id: 'C5', prompt: "What's the weather forecast for Seattle this week?", criteria: { mustProduceOutput: true } },
  { id: 'C6', prompt: 'Best Thai restaurants in Portland' },
  { id: 'C7', prompt: 'Who won the Grammy for Album of the Year?' },
  { id: 'C8', prompt: 'What are the best hiking trails near Denver?' },
  { id: 'C9', prompt: 'Latest SpaceX launch details' },
  { id: 'C10', prompt: 'Best mechanical keyboards under $200' },
  {
    id: 'C11',
    prompt:
      "I'm planning a trip to Tokyo next month. What are the must-visit neighborhoods, best time to visit specific temples, and any current travel advisories?",
    criteria: { ...chatCriteria, minCitations: 2 },
  },
  {
    id: 'C12',
    prompt:
      'Compare the nutritional profiles and health benefits of quinoa, brown rice, and couscous with specific numbers per serving',
    criteria: { ...chatCriteria, minCitations: 2 },
  },
  {
    id: 'C13',
    prompt:
      'What are the latest FDA-approved medications for Type 2 diabetes and how do they compare in terms of efficacy and side effects?',
    criteria: { ...chatCriteria, minCitations: 2 },
  },
  {
    id: 'C14',
    prompt:
      'Show me the top 5 open-source alternatives to Figma for UI design with their GitHub star counts and latest release dates',
    criteria: { ...chatCriteria, minCitations: 2 },
  },
  {
    id: 'C15',
    prompt:
      "What happened in the stock market today? Which sectors are up and which are down, and what's driving the movement?",
    criteria: { ...chatCriteria, minCitations: 2 },
  },
]

// ──────────────────────────────────────────────
// Search Mode Prompts (15)
// ──────────────────────────────────────────────

/** For local business queries, the business homepage IS the correct link (hours, menu, location) */
const localSearchCriteria: EvalCriteria = {
  mustProduceOutput: true,
  mustUseLinkPreviews: true,
}

const searchPrompts = [
  { id: 'S1', prompt: 'latest AI news' },
  { id: 'S2', prompt: 'best restaurants in Portland Oregon', criteria: localSearchCriteria },
  { id: 'S3', prompt: 'Python asyncio tutorial' },
  { id: 'S4', prompt: 'climate change latest research 2026' },
  { id: 'S5', prompt: 'best pizza places in Brooklyn', criteria: localSearchCriteria },
  { id: 'S6', prompt: 'React Server Components guide' },
  { id: 'S7', prompt: 'electric vehicle comparison 2026' },
  { id: 'S8', prompt: 'remote work productivity tips' },
  { id: 'S9', prompt: 'best running shoes 2026' },
  { id: 'S10', prompt: 'machine learning tutorials for beginners' },
  { id: 'S11', prompt: 'new treatments for depression 2026 clinical trials' },
  { id: 'S12', prompt: 'TypeScript 6.0 new features release notes' },
  {
    id: 'S13',
    prompt: 'best noise-cancelling headphones under $300',
    criteria: { ...searchCriteria, noReviewSites: true },
  },
  { id: 'S14', prompt: 'Europa mission NASA launch date 2026' },
  { id: 'S15', prompt: 'independent bookstores near me Portland Oregon', criteria: localSearchCriteria },
]

// ──────────────────────────────────────────────
// Research Mode Prompts (15)
// ──────────────────────────────────────────────

const researchPrompts = [
  {
    id: 'R1',
    prompt: 'Comprehensive analysis of remote work productivity studies',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
  {
    id: 'R2',
    prompt: 'Compare Rust vs Go for backend microservices in 2026',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
  {
    id: 'R3',
    prompt: 'What are the health effects of intermittent fasting?',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
  {
    id: 'R4',
    prompt: 'History and current state of quantum computing',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
  { id: 'R5', prompt: 'How do different countries regulate artificial intelligence?' },
  { id: 'R6', prompt: 'The environmental impact of cryptocurrency mining' },
  { id: 'R7', prompt: 'Current state of nuclear fusion energy research' },
  { id: 'R8', prompt: 'How has social media affected mental health in teenagers?' },
  { id: 'R9', prompt: 'The future of autonomous vehicles — technical and regulatory challenges' },
  { id: 'R10', prompt: 'Comparison of major cloud providers (AWS vs Azure vs GCP) for AI workloads' },
  {
    id: 'R11',
    prompt:
      'Analyze the effectiveness of universal basic income pilots worldwide — which countries have tried it, what were the outcomes, and what do economists say about scaling it?',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
  {
    id: 'R12',
    prompt:
      'What is the current scientific consensus on microplastics in human blood? Summarize the key studies, their methodologies, findings, and where scientists disagree.',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
  {
    id: 'R13',
    prompt:
      'Compare the education systems of Finland, South Korea, and the United States — teaching methods, student outcomes, teacher training, and funding models with specific statistics.',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
  {
    id: 'R14',
    prompt:
      'What are the most promising CRISPR gene therapy applications in 2026? Cover both approved treatments and clinical trials, with details on success rates and ethical debates.',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
  {
    id: 'R15',
    prompt:
      'Investigate the relationship between housing costs, remote work adoption, and population migration in US cities since 2020 — use data from at least 5 different metro areas.',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
]

// ──────────────────────────────────────────────
// Validation Set — different prompts, same criteria philosophy
// Used to verify 100% is real, not overfit to the original prompts
// ──────────────────────────────────────────────

const validationChatPrompts = [
  { id: 'VC1', prompt: 'What are the most popular programming languages in 2026?' },
  {
    id: 'VC2',
    prompt: 'Best wireless earbuds under $150',
    criteria: { ...chatCriteria, noHomepageLinks: true, noReviewSites: false },
  },
  { id: 'VC3', prompt: "What's the current population of Tokyo?" },
  {
    id: 'VC4',
    prompt: 'Compare Tesla Model 3 and BMW i4 for daily commuting',
    criteria: { ...chatCriteria, minCitations: 2 },
  },
  { id: 'VC5', prompt: 'Best Italian restaurants in San Francisco' },
  { id: 'VC6', prompt: 'Who won the most recent Super Bowl and what was the score?' },
  { id: 'VC7', prompt: 'What are the side effects of melatonin supplements?' },
  {
    id: 'VC8',
    prompt: 'Best budget laptops for college students 2026',
    criteria: { ...chatCriteria, noReviewSites: false },
  },
  {
    id: 'VC9',
    prompt: 'Explain the differences between type 1 and type 2 diabetes — causes, symptoms, and treatment options',
    criteria: { ...chatCriteria, minCitations: 2 },
  },
  {
    id: 'VC10',
    prompt: "What's happening with the war in Ukraine right now? Give me the latest developments.",
    criteria: { ...chatCriteria, minCitations: 2 },
  },
]

const validationSearchPrompts = [
  { id: 'VS1', prompt: 'latest cybersecurity threats 2026' },
  { id: 'VS2', prompt: 'best coffee shops in Seattle', criteria: localSearchCriteria },
  { id: 'VS3', prompt: 'Kubernetes deployment best practices' },
  { id: 'VS4', prompt: 'renewable energy breakthroughs 2026' },
  { id: 'VS5', prompt: 'best board games for adults', criteria: localSearchCriteria },
  { id: 'VS6', prompt: 'Svelte vs React comparison' },
  { id: 'VS7', prompt: 'upcoming Marvel movies release dates', criteria: localSearchCriteria },
  { id: 'VS8', prompt: 'beginner yoga routines for flexibility' },
  { id: 'VS9', prompt: 'best budget smartphones 2026' },
  { id: 'VS10', prompt: 'vegan meal prep ideas for the week' },
]

const validationResearchPrompts = [
  {
    id: 'VR1',
    prompt:
      'What is the current state of mRNA vaccine technology beyond COVID? Cover cancer vaccines, flu vaccines, and other applications in development.',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
  {
    id: 'VR2',
    prompt:
      'Analyze the global semiconductor shortage — root causes, which industries were most affected, and what solutions have been implemented.',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
  {
    id: 'VR3',
    prompt:
      'Compare the space programs of the US, China, and India — recent missions, planned missions, budgets, and international collaborations.',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
  {
    id: 'VR4',
    prompt: 'The impact of AI on employment — which jobs are being automated and which new jobs are emerging?',
  },
  { id: 'VR5', prompt: 'What are the latest developments in solid-state battery technology for electric vehicles?' },
  {
    id: 'VR6',
    prompt:
      'Investigate the effectiveness of four-day work week trials worldwide — which companies/countries have tried it and what were the measurable outcomes?',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
  {
    id: 'VR7',
    prompt:
      'The global water crisis — which regions are most affected, what are the main causes, and what technological solutions exist?',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
  { id: 'VR8', prompt: 'How are central banks around the world approaching digital currencies (CBDCs)?' },
  {
    id: 'VR9',
    prompt: 'The ethics and regulation of facial recognition technology — compare approaches in the US, EU, and China.',
  },
  {
    id: 'VR10',
    prompt:
      'Analyze the rise of lab-grown meat — current products on the market, cost comparisons with traditional meat, and consumer acceptance data.',
    criteria: { ...researchCriteria, minCitations: 5 },
  },
]

// ──────────────────────────────────────────────
// Scenario Generation
// ──────────────────────────────────────────────

type PromptDef = { id: string; prompt: string; criteria?: EvalCriteria }

const buildScenarios = (
  prompts: PromptDef[],
  modeName: EvalScenario['modeName'],
  defaultCriteria: EvalCriteria,
): EvalScenario[] =>
  models.flatMap((model) =>
    prompts.map((p) => ({
      id: `${model.name}/${modeName}/${p.id}`,
      modelName: model.name,
      modeName,
      prompt: p.prompt,
      criteria: p.criteria ?? defaultCriteria,
    })),
  )

const allScenarios: EvalScenario[] = [
  ...buildScenarios(chatPrompts, 'chat', chatCriteria),
  ...buildScenarios(searchPrompts, 'search', searchCriteria),
  ...buildScenarios(researchPrompts, 'research', researchCriteria),
  ...buildScenarios(validationChatPrompts, 'chat', chatCriteria),
  ...buildScenarios(validationSearchPrompts, 'search', searchCriteria),
  ...buildScenarios(validationResearchPrompts, 'research', researchCriteria),
]

/** Get scenarios filtered by model names and mode names */
export const getScenarios = (modelNames?: string[], modeNames?: string[]): EvalScenario[] =>
  allScenarios.filter(
    (s) => (!modelNames || modelNames.includes(s.modelName)) && (!modeNames || modeNames.includes(s.modeName)),
  )

/** Get the model ID for a given model name */
export const getModelId = (modelName: string): string => {
  const model = models.find((m) => m.name === modelName)
  if (!model) {
    throw new Error(`Unknown model: ${modelName}`)
  }
  return model.id
}
