/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

type Step = {
  uses?: string
  run?: string
  with?: { ref?: string; tag_name?: string; files?: string }
  env?: { PRERELEASE?: string; LATEST?: string }
}

type Workflow = {
  on: { workflow_call: { inputs: object }; workflow_dispatch: { inputs: object } }
  env?: { RELEASE_TAG?: string }
  jobs: { [name: string]: { needs?: string | string[]; with?: { tag?: string }; steps?: Step[] } }
}

/** Parses a workflow file from `.github/workflows/`. */
const loadWorkflow = (file: string) =>
  Bun.YAML.parse(readFileSync(join(import.meta.dir, '../.github/workflows', file), 'utf8')) as Workflow

/** Collects the steps of every job in a workflow. */
const allSteps = (workflow: Workflow) => Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])

// A single-platform release tags vX.Y.Z-<platform>-rc, so a child that rebuilds the tag from the
// version checks out a missing or older commit (THU-958).
describe('release tag wiring', () => {
  it.each([
    ['desktop', 'desktop-release.yml', 'draft'],
    ['ios', 'ios-release.yml', 'build_and_deploy_ios'],
    ['android', 'android-release.yml', 'build_and_deploy_android'],
  ])('%s builds the tag version-bump created', (platform, file, firstJob) => {
    expect(loadWorkflow('release.yml').jobs[platform].with?.tag).toBe('${{ needs.version_bump.outputs.tag_name }}')

    const child = loadWorkflow(file)
    expect(child.on.workflow_call.inputs).toHaveProperty('tag')
    expect(child.on.workflow_dispatch.inputs).toHaveProperty('tag')
    expect(child.env?.RELEASE_TAG).toBe("${{ inputs.tag || format('v{0}', inputs.version) }}")

    const checkouts = allSteps(child).filter((step) => step.uses?.startsWith('actions/checkout@'))
    expect(checkouts.length).toBeGreaterThan(0)
    for (const step of checkouts) {
      expect(step.with?.ref).toBe('refs/tags/${{ env.RELEASE_TAG }}')
    }

    // The tag/version check runs first, and every other job waits for it.
    expect(child.jobs[firstJob].steps?.[0].run).toContain(`"v$VERSION-${platform}-rc"`)
    for (const [, job] of Object.entries(child.jobs).filter(([name]) => name !== firstJob)) {
      expect([job.needs].flat()).toContain(firstJob)
    }
  })

  it('desktop uploads to and publishes the tag it builds, keeping an RC a prerelease', () => {
    const steps = allSteps(loadWorkflow('desktop-release.yml'))

    const uploads = steps.filter((step) => step.with?.files)
    expect(uploads.length).toBeGreaterThan(0)
    for (const step of uploads) {
      expect(step.with?.tag_name).toBe('${{ env.RELEASE_TAG }}')
    }

    const publish = steps.find((step) => step.run?.includes('gh release edit'))
    expect(publish?.run).toContain('gh release edit "$RELEASE_TAG"')
    expect(publish?.run).toContain('--prerelease="${PRERELEASE}"')
    expect(publish?.env?.PRERELEASE).toBe("${{ endsWith(env.RELEASE_TAG, '-rc') }}")
    expect(publish?.run).toContain('--latest="$LATEST"')
    expect(publish?.env?.LATEST).toBe("${{ inputs.latest && !endsWith(env.RELEASE_TAG, '-rc') }}")
  })
})

it('preview marketing builds use the same API as the preview app', () => {
  const preview = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, '../.github/workflows/preview-deploy.yml'), 'utf8'),
  ) as { jobs: { publish: { with: { vite_backend_url: string } } } }
  const images = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, '../.github/workflows/images-publish.yml'), 'utf8'),
  ) as { jobs: { publish: { steps: { name?: string; with: Record<string, string> }[] } } }
  expect(preview.jobs.publish.with.vite_backend_url).toBe(
    'https://api-pr-${{ needs.resolve.outputs.pr_number }}.preview.thunderbolt.io/v1',
  )
  const marketing = images.jobs.publish.steps.find(
    (step: { name?: string }) => step.name === 'Build and push marketing',
  )
  expect(marketing.with['build-args']).toContain(
    "PUBLIC_CONTACT_ENDPOINT=${{ inputs.vite_backend_url && format('{0}/contact', inputs.vite_backend_url) || '/v1/contact' }}",
  )
  const dockerfile = readFileSync(join(import.meta.dir, '../deploy/docker/marketing.Dockerfile'), 'utf8')
  expect(dockerfile).toContain('ARG PUBLIC_CONTACT_ENDPOINT=/v1/contact')
  expect(dockerfile).toContain('RUN PUBLIC_CONTACT_ENDPOINT="$PUBLIC_CONTACT_ENDPOINT" bun run build')
})
