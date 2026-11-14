/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { evaluate } from './workflow-expression'

type Step = { name?: string; id?: string; run?: string; env?: { [name: string]: string }; with?: { labels?: string } }

type Job = {
  needs?: string | string[]
  if?: string
  environment?: string
  concurrency?: { group: string; 'cancel-in-progress'?: boolean }
  outputs?: { [name: string]: string }
  steps?: Step[]
}

type Workflow = { jobs: { [name: string]: Job | undefined } }

const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, '../.github/workflows/images-publish.yml'), 'utf8'),
) as Workflow
const publish = workflow.jobs.publish
const deploy = workflow.jobs['deploy-powersync']
const deployStep = deploy?.steps?.find((step) => step.name === 'Deploy PowerSync')

/** The command lines of a `run:` script, without comments. */
const commands = (script: string) =>
  script
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

const image = 'ghcr.io/acme/repo/thunderbolt-powersync'

const fakeBin = mkdtempSync(join(tmpdir(), 'images-publish-workflow-'))
afterAll(() => rmSync(fakeBin, { recursive: true, force: true }))

// `render deploys list` answers FAKE_DEPLOYS and every other call is logged; `curl` answers GHCR's
// token, manifest and config-blob requests, the blob carrying FAKE_LABEL. FAKE_FAIL names the tool
// whose reads fail.
writeFileSync(
  join(fakeBin, 'render'),
  `#!/bin/sh
case "$*" in
  "deploys list"*) [ "$FAKE_FAIL" = render ] && exit 1; printf '%s' "$FAKE_DEPLOYS" ;;
  *) echo "$*" >> "$FAKE_RENDER_LOG" ;;
esac
`,
)
writeFileSync(
  join(fakeBin, 'curl'),
  `#!/bin/sh
[ "$FAKE_FAIL" = curl ] && exit 22
for arg; do url="$arg"; done
case "$url" in
  *token*) echo '{"token":"t"}' ;;
  */manifests/*) echo '{"config":{"digest":"sha256:blob"}}' ;;
  */blobs/*) printf '{"config":{"Labels":%s}}' "$FAKE_LABEL" ;;
esac
`,
)
chmodSync(join(fakeBin, 'render'), 0o755)
chmodSync(join(fakeBin, 'curl'), 0o755)

/** Runs the deploy step against a live Render deploy, returning the Render calls that changed something. */
const runDeploy = (live: { image: string; config: string | null } | null, fail = '') => {
  const log = join(fakeBin, `render-${crypto.randomUUID()}`)
  writeFileSync(log, '')
  const deploys = live ? [{ status: 'live', image: { ref: live.image, sha: 'sha256:live' } }] : []
  const label = live?.config ? { 'io.thunderbolt.powersync-config': live.config } : null
  const result = Bun.spawnSync(['bash', '-e', '-c', deployStep?.run ?? 'exit 1'], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_RENDER_LOG: log,
      FAKE_DEPLOYS: JSON.stringify([{ status: 'deactivated', image: { ref: `${image}:0.1.1`, sha: 'x' } }, ...deploys]),
      FAKE_LABEL: JSON.stringify(label),
      FAKE_FAIL: fail,
      SERVICE_ID: 'srv-1',
      REPOSITORY: 'acme/repo/thunderbolt-powersync',
      IMAGE: `${image}:0.1.2`,
      VERSION: '0.1.2',
      POWERSYNC_CONFIG: 'abc',
    },
  })
  return { exitCode: result.exitCode, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) }
}

// images-publish.yml is reusable, so a called run sees its caller's event and ref, and the deploy
// job's environment secrets reach it whatever the caller passes. Only runs on main that publish the
// shared tags may deploy; preview runs always pass a tag override.
describe('PowerSync production deploy', () => {
  it.each([
    ['push', 'refs/heads/main', null, true],
    ['schedule', 'refs/heads/main', null, true],
    ['workflow_dispatch', 'refs/heads/main', null, true],
    ['push', 'refs/heads/feature', null, false],
    ['workflow_dispatch', 'refs/heads/feature', null, false],
    ['workflow_dispatch', 'refs/heads/main', 'pr-42-abc', false],
    ['pull_request_target', 'refs/heads/main', 'pr-42-abc', false],
    ['pull_request', 'refs/pull/42/merge', 'pr-42-abc', false],
  ])('%s on %s with tag override %p deploys: %p', (event, ref, tagOverride, expected) => {
    const context = { 'github.event_name': event, 'github.ref': ref, 'inputs.tag_override': tagOverride }
    expect(evaluate(deploy?.if ?? 'false', context)).toBe(expected)
  })

  it('runs after publish, in the main-only render environment', () => {
    expect(deploy?.needs).toBe('publish')
    expect(deploy?.environment).toBe('render')
  })

  it('lets a newer run cancel an older one, keeping preview builds apart', () => {
    expect(publish?.concurrency).toEqual({
      group:
        "${{ inputs.tag_override && format('images-publish-{0}', github.run_id) || format('images-publish-{0}', github.ref) }}",
      'cancel-in-progress': true,
    })
    expect(deploy?.concurrency).toEqual({ group: 'deploy-powersync', 'cancel-in-progress': true })
  })

  it('labels the PowerSync image with a hash of its Dockerfile and sync config', () => {
    const resolve = publish?.steps?.find((step) => step.id === 'version')?.run ?? ''
    expect(resolve).toContain('cat deploy/docker/powersync.Dockerfile deploy/config/powersync-config.yaml | sha256sum')
    const build = publish?.steps?.find((step) => step.name === 'Build and push powersync')
    expect(build?.with?.labels).toContain(
      'io.thunderbolt.powersync-config=${{ steps.version.outputs.powersync_config }}',
    )
    expect(publish?.outputs?.powersync_config).toBe('${{ steps.version.outputs.powersync_config }}')
    expect(deployStep?.env?.POWERSYNC_CONFIG).toBe('${{ needs.publish.outputs.powersync_config }}')
    expect(deployStep?.env?.IMAGE).toBe(
      '${{ env.IMAGE_PREFIX }}/thunderbolt-powersync:${{ needs.publish.outputs.version }}',
    )
  })

  it('verifies the Render CLI download before unpacking it', () => {
    const install = commands(deploy?.steps?.find((step) => step.name === 'Install Render CLI')?.run ?? '')
    const checkIndex = install.indexOf('echo "${RENDER_CLI_SHA256}  ${archive}" | sha256sum -c -')
    expect(checkIndex).toBeGreaterThan(0)
    expect(checkIndex).toBeLessThan(install.findIndex((line) => line.startsWith('unzip')))
  })

  it('never rolls a newer live version back', () => {
    expect(runDeploy({ image: `${image}:0.1.10`, config: 'old' })).toEqual({ exitCode: 0, calls: [] })
  })

  it('leaves PowerSync running when the version and sync config match', () => {
    expect(runDeploy({ image: `${image}:0.1.2`, config: 'abc' })).toEqual({ exitCode: 0, calls: [] })
  })

  it.each(['render', 'curl'])('fails without deploying when a %s read fails', (tool) => {
    const { exitCode, calls } = runDeploy({ image: `${image}:0.1.2`, config: 'abc' }, tool)
    expect(exitCode).not.toBe(0)
    expect(calls).toEqual([])
  })

  it.each([
    ['a new version', { image: `${image}:0.1.1`, config: 'abc' }],
    ['a changed sync config', { image: `${image}:0.1.2`, config: 'old' }],
    ['a live image without the label', { image: `${image}:0.1.2`, config: null }],
    ['no live deploy', null],
  ])('pins the tag on the service, then deploys, for %s', (_, live) => {
    expect(runDeploy(live)).toEqual({
      exitCode: 0,
      calls: [
        `services update srv-1 --image ${image}:0.1.2 --confirm --output text`,
        'deploys create srv-1 --wait --confirm --output text',
      ],
    })
  })
})
