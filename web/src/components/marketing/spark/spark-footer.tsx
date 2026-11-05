/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { productLinks } from '../../../data/website-product'
import './spark-chrome.css'

export const SparkFooter = () => (
  <footer className="spark-footer spark-shell">
    <div className="spark-footer-top">
      <a className="spark-wordmark" href="/">
        <img src="/enterprise/thunderbolt-logo.png" alt="" width="34" height="34" />
        <span>Thunderbolt</span>
      </a>
      <nav aria-label="Footer navigation">
        <a href={productLinks.github}>GitHub</a>
        <a href={productLinks.discord}>Discord</a>
        <a href="/enterprise/">For your team</a>
        <a href={productLinks.selfHost}>Self-host</a>
        <a href="/docs/">Docs</a>
        <a href="/blog/">Blog</a>
      </nav>
    </div>
    <div className="spark-footer-bottom">
      <span>From Thunderbird. Part of the Mozilla family.</span>
      <a href="https://www.thunderbird.net/en-US/privacy/">Privacy</a>
    </div>
  </footer>
)
