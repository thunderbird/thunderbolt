/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router'
import { projectArtifactPath } from './project-artifact-path'

const Destination = () => {
  const { artifactId } = useParams()
  const { search, hash } = useLocation()
  return <output>{JSON.stringify({ artifactId, search, hash })}</output>
}

it.each(['message-call/id?query#hash', 'message-call%value', 'message-call with spaces'])(
  'round-trips an opaque tool-call ID through the artifact route: %s',
  (artifactId) => {
    render(
      <MemoryRouter initialEntries={[projectArtifactPath('project', artifactId)]}>
        <Routes>
          <Route path="/projects/:projectId/artifacts/:artifactId" element={<Destination />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByRole('status').textContent).toBe(JSON.stringify({ artifactId, search: '', hash: '' }))
  },
)
