/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { evaluate } from './workflow-expression'

type Step = { id?: string; run?: string; env?: { IMAGE?: string }; with?: { filters?: string } }

type Job = {
  needs?: string | string[]
  if?: string
  environment?: string
  concurrency?: { group: string; 'cancel-in-progress'?: boolean }
  outputs?: { changed?: string }
  steps?: Step[]
}

type Workflow = { jobs: { [name: string]: Job | undefined } }

const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, '../.github/workflows/images-publish.yml'), 'utf8'),
) as Workflow
const changes = workflow.jobs['powersync-changes']
const deploy = workflow.jobs['deploy-powersync']

/** The command lines of a `run:` script, without comments. */
const commands = (script: string) =>
  script
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

// images-publish.yml is reusable, so a called run sees its caller's event and ref, and the deploy
// job's environment secrets reach it whatever the caller passes. Only a push to main may deploy.
describe('PowerSync production deploy', () => {
  it.each([
    ['push', 'refs/heads/main', true],
    ['push', 'refs/heads/feature', false],
    ['workflow_dispatch', 'refs/heads/main', false],
    ['schedule', 'refs/heads/main', false],
    ['pull_request', 'refs/pull/42/merge', false],
    ['pull_request_target', 'refs/heads/main', false],
  ])('%s on %s deploys: %p', (event, ref, expected) => {
    const context = {
      'github.event_name': event,
      'github.ref': ref,
      'needs.powersync-changes.outputs.changed': 'true',
    }
    expect(evaluate(changes?.if ?? 'false', context)).toBe(expected)
    expect(evaluate(deploy?.if ?? 'false', context)).toBe(expected)
  })

  it('deploys only when the change check found something', () => {
    const context = { 'github.event_name': 'push', 'github.ref': 'refs/heads/main' }
    expect(evaluate(deploy?.if ?? 'true', { ...context, 'needs.powersync-changes.outputs.changed': 'false' })).toBe(
      false,
    )
    expect(changes?.outputs?.changed).toBe('${{ steps.filter.outputs.powersync }}')
    expect([deploy?.needs].flat()).toEqual(['publish', 'powersync-changes'])
    expect(deploy?.environment).toBe('render')
  })

  it.each(['deploy/config/powersync-config.yaml', 'deploy/docker/powersync.Dockerfile', 'package.json'])(
    'watches %s',
    (path) => {
      const filters = changes?.steps?.find((step) => step.id === 'filter')?.with?.filters ?? ''
      expect((Bun.YAML.parse(filters) as { powersync: string[] }).powersync).toContain(path)
    },
  )

  it('never cancels a running deploy', () => {
    expect(deploy?.concurrency).toEqual({ group: 'powersync-deploy', 'cancel-in-progress': false })
  })

  it('verifies the Render CLI download before unpacking it', () => {
    const install = commands(deploy?.steps?.find((step) => step.run?.includes('sha256sum'))?.run ?? '')
    const check = install.findIndex((line) => line.includes('sha256sum -c -'))
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(install.findIndex((line) => line.startsWith('unzip')))
  })

  it('pins the version tag on the service, then waits for the deploy', () => {
    const step = deploy?.steps?.find((candidate) => candidate.run?.includes('render deploys create'))
    expect(step?.env?.IMAGE).toBe('${{ env.IMAGE_PREFIX }}/thunderbolt-powersync:${{ needs.publish.outputs.version }}')
    expect(commands(step?.run ?? '')).toEqual([
      'render services update "$SERVICE_ID" --image "$IMAGE" --confirm --output text',
      'render deploys create "$SERVICE_ID" --wait --confirm --output text',
    ])
  })
})
