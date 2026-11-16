/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useIdeaStarterState } from './use-idea-starter-state'
import { productLinks } from '../../../data/website-product'

export const IdeaStarter = () => {
  const { idea, setIdea, ideas } = useIdeaStarterState()

  return (
    <div className="spark-workflow">
      <div className="spark-workflow-choices" role="group" aria-label="Explore an example workflow">
        {ideas.map((item) => (
          <button
            key={item.name}
            type="button"
            aria-pressed={idea === item}
            aria-controls="spark-workflow-example"
            onClick={() => setIdea(item)}
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
