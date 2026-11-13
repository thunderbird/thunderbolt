/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { productLinks } from '../../../data/website-product'
import { SparkBurst } from './spark-burst'
import { SparkEnterprisePartnership } from './spark-enterprise-partnership'
import { SparkFooter } from './spark-footer'
import { SiteHeader } from './site-header'
import type { DownloadRelease } from '../download/downloads'
import '@fontsource-variable/lora'
import './spark.css'
import './spark-enterprise.css'

const deploymentOptions = [
  { name: 'Docker Compose', href: productLinks.docker },
  { name: 'Kubernetes', href: productLinks.kubernetes },
  { name: 'AWS', href: productLinks.aws },
] as const

export const SparkEnterprisePage = ({ release }: { release: DownloadRelease }) => (
  <div className="spark-page">
    <a className="spark-skip" href="#enterprise-main">
      Skip to content
    </a>
    <SiteHeader currentPage="Enterprise" release={release} />
    <main id="enterprise-main">
      <section className="spark-enterprise-hero spark-shell">
        <h1>
          Keep your trade secrets
          <br />
          <span className="spark-heading-accent">secret.</span>
        </h1>
        <p>
          An open-source AI workspace for your organization. Bring your people, choose your models, and run it on
          infrastructure you control.
        </p>
        <div className="spark-hero-actions">
          <a className="spark-button" href="/contact/">
            Let’s talk enterprise <span aria-hidden="true">↗</span>
          </a>
          <a className="spark-text-link" href={productLinks.selfHost}>
            <span className="spark-text-link-label">Explore self-hosting</span> <span aria-hidden="true">↗</span>
          </a>
        </div>
        <SparkBurst className="spark-enterprise-burst" />
      </section>
      <SparkEnterprisePartnership />
      <section className="spark-enterprise-foundations spark-shell" aria-labelledby="enterprise-foundations">
        <div className="spark-section-intro">
          <h2 id="enterprise-foundations">Work smarter, not harder.</h2>
          <p>Give your team powerful tools and keep the choices that matter.</p>
        </div>
        <div className="spark-feature-lines">
          <a href={productLinks.selfHost}>
            <h3>Your infrastructure.</h3>
            <p>Host your workspace on your own systems, with deployment guides you can inspect and adapt.</p>
          </a>
          <a href="/docs/self-hosting/models/">
            <h3>Your models.</h3>
            <p>Connect supported providers or your own compatible endpoints. Choose where inference runs.</p>
          </a>
          <a href="/docs/self-hosting/authentication/">
            <h3>Your access.</h3>
            <p>Connect your organization’s identity provider with OIDC or SAML single sign-on.</p>
          </a>
        </div>
      </section>
      <section className="spark-enterprise-deploy">
        <div className="spark-shell spark-enterprise-deploy-layout">
          <div>
            <h2>
              The code is open.
              <br />
              Make it your own
            </h2>
            <p>Start with the self-hosting guides, explore the source, or talk with us about what your team needs.</p>
            <a className="spark-text-link" href={productLinks.github}>
              <span className="spark-text-link-label">Explore GitHub</span> <span aria-hidden="true">↗</span>
            </a>
          </div>
          <div className="spark-enterprise-deploy-links">
            {deploymentOptions.map((option) => (
              <a href={option.href} key={option.name}>
                {option.name}
                <span aria-hidden="true">↗</span>
              </a>
            ))}
            <a href={productLinks.privacy}>
              Security & privacy<span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </section>
      <section className="spark-enterprise-contact spark-shell">
        <h2>Let’s build on your terms.</h2>
        <a className="spark-button" href="/contact/">
          Contact the team <span aria-hidden="true">↗</span>
        </a>
      </section>
    </main>
    <SparkFooter />
  </div>
)
