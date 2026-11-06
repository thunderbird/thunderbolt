/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId } from 'react'
import './spark-chrome.css'
import { productLinks } from '../../../data/website-product'
import { useSparkHeaderState } from './use-spark-header-state'
import { SiteThemeToggle } from '../../site-theme/site-theme-toggle'

const primaryPages = [
  { label: 'Privacy', href: '/privacy/' },
  { label: 'Enterprise', href: '/enterprise/' },
  { label: 'Docs', href: '/docs/' },
] as const

const morePages = [
  { label: 'Blog', href: '/blog/' },
  { label: 'Contact', href: '/contact/' },
] as const

type SparkHeaderProps = {
  currentPage?: (typeof primaryPages | typeof morePages)[number]['label']
  as?: 'header' | 'div'
}

export const SparkHeader = ({ currentPage, as: Element = 'header' }: SparkHeaderProps) => {
  const { isOpen, toggleNavigation, closeNavigation, onNavigationBlur, navigationRef, triggerRef } =
    useSparkHeaderState()
  const panelId = useId()

  return (
    <Element className="spark-header spark-shell">
      <a className="spark-wordmark" href="/" aria-label="Thunderbolt home">
        <img src="/enterprise/thunderbolt-logo.png" alt="" width="34" height="34" />
        <span>Thunderbolt</span>
      </a>
      <nav className="spark-main-nav" aria-label="Main navigation">
        {primaryPages.map((page) => (
          <a
            key={page.href}
            className="spark-nav-direct"
            data-nav-page={page.label}
            href={page.href}
            aria-current={currentPage === page.label ? 'page' : undefined}
          >
            {page.label}
          </a>
        ))}
        <div className="spark-nav-disclosure" ref={navigationRef} onBlur={onNavigationBlur}>
          <button
            className="spark-nav-trigger"
            type="button"
            aria-expanded={isOpen}
            aria-controls={panelId}
            ref={triggerRef}
            onClick={toggleNavigation}
          >
            More
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="m4 6 4 4 4-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <div className="spark-nav-panel" id={panelId} hidden={!isOpen}>
            <div className="spark-nav-pages">
              {[...primaryPages, ...morePages].map((page) => (
                <a
                  key={page.href}
                  data-nav-page={page.label}
                  href={page.href}
                  aria-current={currentPage === page.label ? 'page' : undefined}
                  onClick={closeNavigation}
                >
                  {page.label}
                  <span aria-hidden="true">→</span>
                </a>
              ))}
            </div>
            <div className="spark-nav-community">
              <a href={productLinks.github}>
                GitHub <span aria-hidden="true">↗</span>
              </a>
              <a href={productLinks.discord}>
                Discord <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
        </div>
      </nav>
      <div className="spark-header-actions">
        <SiteThemeToggle />
        <a className="spark-nav-cta" href={productLinks.download}>
          Download <span aria-hidden="true">↓</span>
        </a>
      </div>
    </Element>
  )
}
