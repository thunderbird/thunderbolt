/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const announcement = 'https://www.deepset.ai/news/sovereign-ai-stack-mozilla-thunderbolt-haystack'

export const SparkEnterprisePartnership = () => (
  <section
    id="enterprise-partnership"
    className="spark-partnership spark-shell"
    aria-labelledby="enterprise-partnership-title"
  >
    <div className="spark-partnership-copy">
      <p className="spark-partnership-intro">Thunderbolt + deepset</p>
      <h2 id="enterprise-partnership-title">
        Your knowledge.
        <br />
        Put to work.
      </h2>
      <p>
        A great AI workspace is only the beginning. Our partnership with deepset connects Thunderbolt to Haystack’s
        agents, retrieval, and orchestration—so your team can work with the knowledge that makes your organization
        yours.
      </p>
      <p>
        Thunderbolt is where people ask, explore, and get things done. Haystack is the foundation connecting models,
        data, and workflows. You choose the infrastructure beneath it all.
      </p>
      <a className="spark-text-link" href={announcement}>
        <span className="spark-text-link-label">Explore the partnership</span> <span aria-hidden="true">↗</span>
      </a>
    </div>
    <div
      className="spark-partnership-stack"
      role="img"
      aria-label="Thunderbolt is the workspace for your team. Haystack by deepset connects agents, retrieval and workflows to your choice of models, data and infrastructure."
    >
      <div className="spark-stack-layer spark-stack-workspace">
        <div className="spark-stack-wordmark">
          <img src="/enterprise/thunderbolt-logo.png" width="32" height="32" alt="" />
          <span>Thunderbolt</span>
        </div>
        <p>The workspace for your team</p>
        <div className="spark-stack-question">
          What changed in the launch plan?<span aria-hidden="true">↗</span>
        </div>
      </div>
      <div className="spark-stack-connector" aria-hidden="true">
        <span />
      </div>
      <div className="spark-stack-layer spark-stack-haystack">
        <div className="spark-haystack-logo">
          <img src="/images/partners/haystack-mark.svg" alt="" width="54" height="54" />
          <div>
            <span className="spark-haystack-name">haystack</span>
            <span className="spark-haystack-byline">by deepset</span>
          </div>
        </div>
        <p>Agents. Retrieval. Workflows.</p>
      </div>
      <div className="spark-stack-connector" aria-hidden="true">
        <span />
      </div>
      <div className="spark-stack-foundation">
        <span>Your models</span>
        <span>Your data</span>
        <span>Your infrastructure</span>
      </div>
    </div>
    <div className="spark-partnership-delivery">
      <div>
        <h3>Open technology. Hands-on help.</h3>
        <p>
          deepset’s forward-deployed engineers can work alongside your team on architecture, implementation, and
          operations—including sovereign deployments in Europe.
        </p>
      </div>
      <a className="spark-text-link" href="/contact/">
        <span className="spark-text-link-label">Plan your deployment</span> <span aria-hidden="true">↗</span>
      </a>
    </div>
  </section>
)
