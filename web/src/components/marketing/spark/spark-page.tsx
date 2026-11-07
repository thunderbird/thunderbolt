/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { productLinks } from '../../../data/website-product'
import { IdeaStarter } from './idea-starter'
import { ProductPreview } from './product-preview'
import { SparkBurst } from './spark-burst'
import { SparkInstall } from './spark-install'
import { SparkHeader } from './spark-header'
import { SparkFooter } from './spark-footer'
import '@fontsource-variable/lora'
import './spark.css'

const questions = [
  {
    question: 'Can I choose my own AI?',
    answer:
      'Yes. Connect a compatible model provider, including a local model server, or bring an external agent with its own models and tools. You can change your setup as your needs change.',
    link: '/docs/customize',
    label: 'Explore your options',
  },
  {
    question: 'Where does my data go?',
    answer:
      'Your workspace lives on your device. Synced content is end-to-end encrypted. Your chosen provider or agent processes the prompts you send it; sync encryption does not hide those requests. Encryption is in preview and has not yet had a cryptography audit.',
    link: productLinks.privacy,
    label: 'Understand your data',
  },
  {
    question: 'Can it work with my tools?',
    answer:
      'Add MCP tools to the built-in assistant, or connect external agents through ACP. An agent with browser or computer-use tools can bring those capabilities into your workspace.',
    link: productLinks.connections,
    label: 'Make the connections',
  },
  {
    question: 'Can my team make it our own?',
    answer:
      'Self-host Thunderbolt with Docker Compose, Kubernetes, or AWS. Connect your identity provider and choose the models and infrastructure that work for your organization. You can also deploy a public agent with the Render blueprint.',
    link: productLinks.selfHost,
    label: 'Explore self-hosting',
  },
] as const

export const SparkPage = () => (
  <div className="spark-page">
    <a className="spark-skip" href="#spark-main">
      Skip to content
    </a>
    <SparkHeader />
    <main id="spark-main">
      <section className="spark-hero" aria-labelledby="spark-title">
        <div className="spark-hero-heading spark-shell">
          <h1 id="spark-title">
            AI that feels like yours.
            <br />
            <span className="spark-heading-accent">Because it is.</span>
          </h1>
          <p>
            <span>An open-source AI workspace for chat, research, code, and getting things done.</span>{' '}
            <span>Your models. Your tools. Your way.</span>
          </p>
          <div className="spark-hero-actions">
            <a className="spark-button" href={productLinks.download}>
              Download Thunderbolt <span aria-hidden="true">↓</span>
            </a>
            <a className="spark-text-link" href={productLinks.web}>
              <span className="spark-text-link-label">Try it on the web</span> <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
        <ProductPreview />
      </section>

      <section className="spark-freedom spark-shell" id="spark-workspace">
        <div className="spark-section-intro">
          <h2>A little more freedom.</h2>
          <p>Think, make, and work your own way.</p>
        </div>
        <div className="spark-feature-lines">
          <a href="/docs/customize">
            <h3>Choose your AI.</h3>
            <p>Use your favorite models, run one locally, or try something new.</p>
          </a>
          <a href={productLinks.connections}>
            <h3>Bring your tools.</h3>
            <p>Connect the services, skills, and agents that make you more capable.</p>
          </a>
          <a href={productLinks.privacy}>
            <h3>Keep your independence.</h3>
            <p>Local-first storage. Encrypted sync. Open source you can inspect and change.</p>
          </a>
        </div>
      </section>

      <section className="spark-making" id="spark-making">
        <div className="spark-shell">
          <div className="spark-section-intro">
            <h2>Follow that thought.</h2>
            <p>Find an answer. Build a thing. Give an agent a job.</p>
          </div>
          <IdeaStarter />
        </div>
      </section>

      <section className="spark-manifesto" id="spark-values">
        <div className="spark-shell spark-manifesto-layout">
          <div>
            <h2>
              Good technology
              <br />
              should leave you
              <br />
              <span>more free.</span>
            </h2>
            <SparkBurst className="spark-manifesto-burst" />
          </div>
          <div className="spark-manifesto-copy">
            <p>
              Free to follow a strange idea. To choose a different model. To see how it works, change what you need, and
              build something we haven’t imagined.
            </p>
            <p>
              From the Thunderbird team, part of the Mozilla family. Built in the open, for a future we all get to
              shape.
            </p>
            <a className="spark-text-link" href={productLinks.fork}>
              <span className="spark-text-link-label">Make it your own on GitHub</span>{' '}
              <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </section>

      <section className="spark-questions spark-shell">
        <div>
          <h2>
            A few things
            <br />
            worth knowing.
          </h2>
          <a className="spark-text-link" href="/docs">
            <span className="spark-text-link-label">Explore the docs</span> <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="spark-accordion">
          {questions.map((item) => (
            <details key={item.question}>
              <summary>
                {item.question}
                <span aria-hidden="true">+</span>
              </summary>
              <div>
                <p>{item.answer}</p>
                <a href={item.link}>
                  {item.label} <span aria-hidden="true">↗</span>
                </a>
                {item.link === productLinks.selfHost && (
                  <a href={productLinks.render}>Deploy a public agent on Render ↗</a>
                )}
              </div>
            </details>
          ))}
        </div>
      </section>

      <section className="spark-closing" id="spark-download">
        <div className="spark-closing-sun" aria-hidden="true" />
        <div className="spark-shell">
          <h2>
            Go on.
            <br />
            Surprise yourself.
          </h2>
          <SparkInstall />
        </div>
      </section>
    </main>
    <SparkFooter />
  </div>
)
