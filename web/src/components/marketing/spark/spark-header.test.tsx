/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import { SparkHeader } from '../spark/spark-header'

test('the server-rendered header links to the web app without release data or JavaScript', () => {
  const container = document.createElement('div')
  container.innerHTML = renderToString(<SparkHeader />)
  const desktop = container.querySelector('.spark-nav-cta')!
  const mobile = container.querySelector('.spark-nav-mobile-web')!
  expect(desktop.getAttribute('href')).toBe('https://app.thunderbolt.io/')
  expect(desktop.textContent).toContain('Try it on the web')
  expect(mobile.getAttribute('href')).toBe(desktop.getAttribute('href'))
  expect(mobile.textContent).toContain('Login')
})
