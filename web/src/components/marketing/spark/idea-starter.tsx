/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { productLinks } from '../../../data/website-product'

const ideas = [
  {
    name: 'Follow a question',
    prompt: 'Help me turn this unused corner into a tiny urban garden.',
    steps: [
      'Research plants that thrive in the shade',
      'Compare small-space growing methods',
      'Bring the ideas together into a plan',
    ],
    detail: 'Explore a hunch with your model and connected search tools.',
  },
  {
    name: 'Make something',
    prompt: 'Build a little tool that helps our book club choose what to read next.',
    steps: ['Read the project and make a plan', 'Build the voting interface', 'Run the checks and refine the result'],
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

export const IdeaStarter = () => {
  const [active, setActive] = useState(1)
  const idea = ideas[active]

  return (
    <div className="spark-workflow">
      <div className="spark-workflow-choices" role="group" aria-label="Explore an example workflow">
        {ideas.map((item, index) => (
          <button
            key={item.name}
            type="button"
            aria-pressed={active === index}
            aria-controls="spark-workflow-example"
            onClick={() => setActive(index)}
          >
            {item.name}
            <span aria-hidden="true">↗</span>
          </button>
        ))}
        <a className="spark-text-link" href={productLinks.connections}>
          <span className="spark-text-link-label">Explore connected tools</span> <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div className="spark-workflow-card" id="spark-workflow-example" aria-live="polite" aria-atomic="true">
        <h3>“{idea.prompt}”</h3>
        <ul>
          {idea.steps.map((step) => (
            <li key={step}>
              <span aria-hidden="true">↳</span>
              {step}
            </li>
          ))}
        </ul>
        <p>{idea.detail}</p>
        <span className="spark-example-note">Illustrative workflow</span>
      </div>
    </div>
  )
}
