/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId, type ReactNode } from 'react'
import './spark-chrome.css'
import { productLinks } from '../../../data/website-product'
import { useSparkHeaderState } from './use-spark-header-state'
import { SiteThemeToggle } from '../../site-theme/site-theme-toggle'

const pages = [
  { label: 'Docs', href: '/docs/' },
  { label: 'Blog', href: '/blog/' },
  { label: 'Enterprise', href: '/enterprise/' },
  { label: 'Contact', href: '/contact/' },
] as const

type SparkHeaderProps = {
  currentPage?: (typeof pages)[number]['label']
  as?: 'header' | 'div'
  children?: ReactNode
}

export const SparkHeader = ({ currentPage, as: Element = 'header', children }: SparkHeaderProps) => {
  const { isOpen, setIsOpen, navigationRef, triggerRef } = useSparkHeaderState()
  const panelId = useId()

  return (
    <Element className="spark-header spark-shell">
      <a className="spark-wordmark" href="/" aria-label="Thunderbolt home">
        <img src="/enterprise/thunderbolt-logo.png" alt="" width="34" height="34" />
        <span>Thunderbolt</span>
      </a>
      <nav className="spark-main-nav" aria-label="Main navigation">
        <div
          className="spark-nav-disclosure"
          ref={navigationRef}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setIsOpen(false)
          }}
        >
          <button
            className="spark-nav-trigger"
            type="button"
            aria-expanded={isOpen}
            aria-controls={panelId}
            ref={triggerRef}
            onClick={() => setIsOpen(!isOpen)}
          >
            Explore
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
          {isOpen && (
            <div className="spark-nav-panel" id={panelId}>
              <div className="spark-nav-pages">
                {pages.map((page) => (
                  <a
                    key={page.href}
                    href={page.href}
                    aria-current={currentPage === page.label ? 'page' : undefined}
                    onClick={() => setIsOpen(false)}
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
          )}
        </div>
        <a className="spark-nav-values" href="/#spark-values">
          Our values
        </a>
      </nav>
      <div className="spark-header-actions">
        <SiteThemeToggle />
        {children ?? (
          <a className="spark-nav-cta" href={productLinks.download}>
            Download <span aria-hidden="true">↓</span>
          </a>
        )}
      </div>
    </Element>
  )
}
