/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'

const ideas = [
  {
    name: 'Make sense of it',
    prompt: 'Help me understand this report and pull out what matters for my team.',
    steps: ['Pull out the key findings', 'Flag gaps and unanswered questions', 'Draft a concise summary for the team'],
    detail: 'Work through the details with your model, then dig deeper with connected search tools.',
  },
  {
    name: 'Make something',
    prompt: 'Turn this sales spreadsheet into a dashboard with charts and filters.',
    steps: [
      'Inspect the data and plan the dashboard',
      'Build the charts and filters',
      'Check the results against the source data',
    ],
    detail: 'Put the coding agent to work in your project with Thunderbolt CLI.',
  },
  {
    name: 'Put an agent to work',
    prompt: 'Walk through our new signup page and show me what needs fixing.',
    steps: [
      'Connect an agent with browser tools',
      'Let it navigate and inspect the page',
      'Review the findings in your workspace',
    ],
    detail: 'Bring computer use into your workspace through a connected agent.',
  },
] as const

/** Selects the workflow shown in the interactive example. */
export const useIdeaStarterState = () => {
  const [idea, setIdea] = useState<(typeof ideas)[number]>(ideas[1])
  return { idea, setIdea, ideas }
}
