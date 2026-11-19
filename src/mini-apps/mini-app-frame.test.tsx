/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'bun:test'
import { AppWindow } from 'lucide-react'
import { MiniAppFrame } from './mini-app-frame'

it('explains how operators can update a guest that cannot identify its document', () => {
  render(
    <MiniAppFrame
      app={{
        id: 'old',
        name: 'Old app',
        description: '',
        url: 'https://app.example',
        origin: 'https://app.example',
        icon: AppWindow,
      }}
      frameRef={{ current: null }}
      status="unsupported"
      onFrameLoad={() => {}}
      onRetry={() => {}}
    />,
  )
  expect(
    screen.getByText('This mini app uses an outdated SDK. Ask its maintainer to update the SDK and redeploy it.'),
  ).toBeVisible()
})
