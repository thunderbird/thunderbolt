/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

type Step = {
  uses?: string
  run?: string
  with?: { only_update?: boolean; message?: string; 'persist-credentials'?: boolean }
}

type Concurrency = { group: string; 'cancel-in-progress': boolean }

type Job = {
  name?: string
  needs?: string | string[]
  if?: string
  uses?: string
  with?: { ref?: string; tag_override?: string }
  concurrency?: Concurrency
  steps?: Step[]
}

type Workflow = {
  on: { [event: string]: { types?: string[]; paths?: string[]; inputs?: object } | null }
  concurrency: Concurrency
  jobs: { [name: string]: Job | undefined }
}

const repoRoot = join(import.meta.dir, '..')

/** Parses a workflow file from `.github/workflows/`. */
const loadWorkflow = (file: string) =>
  Bun.YAML.parse(readFileSync(join(repoRoot, '.github/workflows', file), 'utf8')) as Workflow

const workflow = loadWorkflow('preview-deploy.yml')
const { jobs } = workflow

const fakeBin = mkdtempSync(join(tmpdir(), 'preview-workflow-'))
afterAll(() => rmSync(fakeBin, { recursive: true, force: true }))

// Answers `gh pr view` from FAKE_HEAD_*.
writeFileSync(
  join(fakeBin, 'gh'),
  `#!/bin/sh
case "$*" in
  *headRefOid*) echo "$FAKE_HEAD_SHA" ;;
  *headRepository*) echo "$FAKE_HEAD_REPO" ;;
esac
`,
)
chmodSync(join(fakeBin, 'gh'), 0o755)

/** Runs a workflow `run:` script the way Actions does (`bash -e`), with `gh` stubbed. */
const runScript = (script: string, env: Record<string, string>) => {
  const outputFile = join(fakeBin, `output-${crypto.randomUUID()}`)
  writeFileSync(outputFile, '')
  const result = Bun.spawnSync(['bash', '-e', '-c', script], {
    env: {
      ...process.env,
      ...env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      GITHUB_OUTPUT: outputFile,
    },
  })
  const outputs = Object.fromEntries(
    readFileSync(outputFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('=', 2) as [string, string]),
  )
  return { exitCode: result.exitCode, outputs }
}

type ExpressionContext = { [path: string]: string | number | boolean | null }

/**
 * Evaluates a workflow expression. The ones under test only use syntax JS shares
 * (==, !=, !, &&, ||, quotes) plus the `cancelled()` status function.
 */
const evaluate = (expression: string, context: ExpressionContext) => {
  const js = expression
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
    .replace(/\bcancelled\(\)/g, String(context['cancelled()'] ?? false))
    .replace(/\b(?:github|inputs|needs)(?:\.[\w-]+)+/g, (path) => JSON.stringify(context[path] ?? null))
  return new Function(`return ${js}`)()
}

/** Interpolates every `${{ }}` in a template string, such as the concurrency group. */
const interpolate = (template: string, context: ExpressionContext) =>
  template.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) => String(evaluate(expression, context)))

const resolveScript = jobs.resolve?.steps?.find((step) => step.run?.includes('EVENT_NAME'))?.run ?? ''

const eventHeadSha = 'a'.repeat(40)
const dispatchHeadSha = 'b'.repeat(40)

/** Runs resolve; a fork dispatch passes the current head as the reviewed SHA unless told otherwise. */
const resolveFor = (
  event: string,
  headRepo: string,
  reviewedSha = event === 'workflow_dispatch' && headRepo !== 'acme/repo' ? dispatchHeadSha : '',
) =>
  runScript(resolveScript, {
    EVENT_NAME: event,
    EVENT_PR_NUMBER: event === 'workflow_dispatch' ? '' : '42',
    EVENT_HEAD_SHA: event === 'workflow_dispatch' ? '' : eventHeadSha,
    EVENT_HEAD_REPO: event === 'workflow_dispatch' ? '' : headRepo,
    EVENT_BASE_REPO: 'acme/repo',
    INPUT_PR_NUMBER: event === 'workflow_dispatch' ? '42' : '',
    INPUT_HEAD_SHA: reviewedSha,
    FAKE_HEAD_SHA: dispatchHeadSha,
    FAKE_HEAD_REPO: headRepo,
  })

/** Whether publish and deploy run for one resolve result. */
const gate = (resolved: { proceed?: string; is_fork?: string }, { cancelled = false } = {}) => {
  const context = {
    'needs.resolve.outputs.proceed': resolved.proceed ?? '',
    'needs.resolve.outputs.is_fork': resolved.is_fork ?? '',
    'needs.publish.result': 'success',
    'cancelled()': cancelled,
  }
  return {
    publishes: evaluate(jobs.publish?.if ?? 'false', context) === true,
    deploys: evaluate(jobs.deploy?.if ?? 'false', context) === true,
  }
}

describe('preview deploy trust policy', () => {
  it.each([
    ['pull_request', 'acme/repo', 'true', 'false'],
    ['pull_request', 'someone/fork', 'false', undefined],
    ['workflow_dispatch', 'acme/repo', 'true', 'false'],
    ['workflow_dispatch', 'someone/fork', 'true', 'true'],
  ])('routes %s from %s', (event, headRepo, proceed, isFork) => {
    const { exitCode, outputs } = resolveFor(event, headRepo)
    expect(exitCode).toBe(0)
    expect(outputs.proceed).toBe(proceed)
    expect(outputs.is_fork).toBe(isFork)
  })

  it.each([
    ['pull_request', 'acme/repo'],
    ['workflow_dispatch', 'acme/repo'],
  ])('deploys a same-repo PR on %s', (event, headRepo) => {
    expect(gate(resolveFor(event, headRepo).outputs)).toEqual({ publishes: true, deploys: true })
  })

  it('deploys a fork PR only from a dispatch', () => {
    expect(gate(resolveFor('pull_request', 'someone/fork').outputs).publishes).toBe(false)
    expect(gate(resolveFor('workflow_dispatch', 'someone/fork').outputs)).toEqual({ publishes: true, deploys: true })
  })

  it.each([
    ['no reviewed SHA', 'someone/fork', ''],
    ['a fork PR that moved past the reviewed SHA', 'someone/fork', eventHeadSha],
    ['a same-repo PR that moved past the given SHA', 'acme/repo', eventHeadSha],
  ])('fails a dispatch with %s', (_, headRepo, reviewedSha) => {
    const { exitCode, outputs } = resolveFor('workflow_dispatch', headRepo, reviewedSha)
    expect(exitCode).not.toBe(0)
    expect(outputs.proceed).toBeUndefined()
  })

  it('stops publishing and deploying once a newer push cancels the run', () => {
    const internal = resolveFor('pull_request', 'acme/repo').outputs
    const fork = resolveFor('workflow_dispatch', 'someone/fork').outputs
    expect(gate(internal, { cancelled: true })).toMatchObject({ publishes: false, deploys: false })
    expect(gate(fork, { cancelled: true })).toMatchObject({ publishes: false, deploys: false })
  })

  it('resolve runs no action', () => {
    expect(jobs.resolve?.uses).toBeUndefined()
    expect(jobs.resolve?.steps?.filter((step) => step.uses)).toEqual([])
  })

  it('builds and tags the resolved head SHA', () => {
    const headSha = '${{ needs.resolve.outputs.head_sha }}'
    expect(jobs.publish?.with?.ref).toBe(headSha)
    expect(jobs.publish?.with?.tag_override).toContain(headSha)

    expect(resolveFor('pull_request', 'acme/repo').outputs.head_sha).toBe(eventHeadSha)
    expect(resolveFor('workflow_dispatch', 'someone/fork').outputs.head_sha).toBe(dispatchHeadSha)
  })

  it('makes a new push start a new run', () => {
    expect(workflow.on.pull_request?.types).toEqual(expect.arrayContaining(['synchronize', 'reopened']))
    expect(workflow.concurrency['cancel-in-progress']).toBe(true)
  })

  // Every run that can deploy shares one group, so a push cancels them all, dispatched ones included.
  it.each([
    ['a same-repo pull_request', 'deploy', 'pull_request', 'acme/repo'],
    ['a dispatch', 'deploy', 'workflow_dispatch', null],
    ['the no-op fork pull_request', 'fork', 'pull_request', 'someone/fork'],
  ])('puts %s in the %s group', (_, group, event, headRepo) => {
    const dispatch = event === 'workflow_dispatch'
    expect(
      interpolate(workflow.concurrency.group, {
        'github.event_name': event,
        'github.event.pull_request.number': dispatch ? null : 42,
        'inputs.pr_number': dispatch ? '42' : null,
        'github.event.pull_request.head.repo.full_name': headRepo,
        'github.repository': 'acme/repo',
      }),
    ).toBe(`preview-pr-42-${group}`)
  })

  it.each(readdirSync(join(repoRoot, '.github/workflows')).filter((file) => file.endsWith('.yml')))(
    '%s does not trigger on pull_request_target',
    (file) => {
      const on: unknown = loadWorkflow(file).on
      const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {})
      expect(events).not.toContain('pull_request_target')
    },
  )
})

describe('checkout credentials', () => {
  const workflowFiles = readdirSync(join(repoRoot, '.github/workflows')).filter((file) => file.endsWith('.yml'))
  const checkouts = workflowFiles.flatMap((file) =>
    Object.entries(loadWorkflow(file).jobs).flatMap(([job, definition]) =>
      (definition?.steps ?? [])
        .filter((step) => step.uses?.startsWith('actions/checkout@'))
        .map((step) => ({ at: `${file} ${job}`, persists: step.with?.['persist-credentials'] !== false })),
    ),
  )

  // Only jobs that push or tag with git keep the token in .git/config.
  it('keeps credentials only in the jobs that push', () => {
    expect(
      checkouts
        .filter((checkout) => checkout.persists)
        .map((checkout) => checkout.at)
        .sort(),
    ).toEqual(['create-version-tag.yml create_tag', 'evals.yml scheduled-full', 'version-bump.yml version_bump'])
  })
})

/** GitHub's `paths` filter for one file: patterns apply in order, `!` excludes, the last match wins. */
const matchesPaths = (patterns: string[], file: string) =>
  patterns.reduce(
    (included, pattern) =>
      pattern.startsWith('!')
        ? included && !new Bun.Glob(pattern.slice(1)).match(file)
        : included || new Bun.Glob(pattern).match(file),
    false,
  )

/**
 * The preview Dockerfiles and every build-context source they copy in. Reads single-line `COPY`
 * only, so an `ADD` or a `RUN --mount=type=bind` source would need adding here.
 */
const dockerfileInputs = () => {
  const dockerfiles = readdirSync(join(repoRoot, 'deploy/docker'))
    .filter((name) => name.endsWith('.Dockerfile'))
    .map((name) => `deploy/docker/${name}`)
  const sources = dockerfiles.flatMap((dockerfile) =>
    readFileSync(join(repoRoot, dockerfile), 'utf8')
      .split('\n')
      .filter((line) => /^COPY\s/.test(line) && !line.includes('--from='))
      .flatMap((line) =>
        line
          .split(/\s+/)
          .slice(1, -1)
          .filter((arg) => !arg.startsWith('--')),
      ),
  )
  return [...dockerfiles, ...sources]
}

describe('preview deploy path gate', () => {
  const paths = workflow.on.pull_request?.paths ?? []

  it('gates pull_request on the preview inputs and keeps dispatch as the override', () => {
    expect(paths.length).toBeGreaterThan(0)
    expect(workflow.on.pull_request_target).toBeUndefined()
    expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty('pr_number')
  })

  it.each(dockerfileInputs())('deploys when %s changes', (source) => {
    const file = statSync(join(repoRoot, source)).isDirectory() ? `${source}/x` : source
    expect(matchesPaths(paths, file)).toBe(true)
  })

  it.each([
    ['src/a.ts', true],
    ['backend/drizzle/0001.sql', true],
    ['docs/x.md', true],
    ['web/src/a.astro', true],
    ['deploy/pulumi/index.ts', true],
    ['.github/workflows/stack-deploy.yml', true],
    ['e2e/preview-smoke.spec.ts', true],
    ['src/a.test.ts', false],
    ['src/x/__snapshots__/a.test.ts.snap', false],
    ['backend/src/a.test.ts', false],
    ['e2e/a.spec.ts', false],
    ['.github/workflows/ci.yml', false],
    ['cli/src/a.ts', false],
    ['src-tauri/src/main.rs', false],
    ['deploy/k8s/values.yaml', false],
    ['README.md', false],
    ['.claude/x', false],
  ])('a change to %s deploys a preview: %p', (file, deploys) => {
    expect(matchesPaths(paths, file)).toBe(deploys)
  })
})

describe('release image path gate', () => {
  const paths = loadWorkflow('images-publish.yml').on.push?.paths ?? []

  it.each(dockerfileInputs())('rebuilds the images on main when %s changes', (source) => {
    const file = statSync(join(repoRoot, source)).isDirectory() ? `${source}/x` : source
    expect(matchesPaths(paths, file)).toBe(true)
  })
})

describe('preview teardown', () => {
  it('tears down same-repo PRs on close and leaves fork PRs to the hourly cleanup', () => {
    const teardown = loadWorkflow('preview-destroy.yml')
    expect(teardown.on.pull_request?.types).toEqual(['closed'])
    const runs = (event: string, headRepo: string | null) =>
      evaluate(teardown.jobs['resolve-pr']?.if ?? 'true', {
        'github.event_name': event,
        'github.event.pull_request.head.repo.full_name': headRepo,
        'github.repository': 'acme/repo',
      }) === true
    expect(runs('pull_request', 'acme/repo')).toBe(true)
    expect(runs('pull_request', 'someone/fork')).toBe(false)
    expect(runs('workflow_dispatch', null)).toBe(true)
  })

  it('only rewrites an existing preview comment', () => {
    const comment = loadWorkflow('preview-destroy.yml').jobs.comment?.steps?.find((step) =>
      step.uses?.startsWith('marocchino/sticky-pull-request-comment@'),
    )
    expect(comment?.with?.only_update).toBe(true)
  })

  it('says the cleanup took over when a newer destroy of the same stack supersedes this one', () => {
    const comment = loadWorkflow('preview-destroy.yml').jobs.comment
    expect(comment?.if).not.toContain('needs.destroy.result')
    expect(comment?.steps?.[0]?.with?.message).toContain(
      "needs.destroy.result == 'cancelled' && '**Preview teardown handed to the hourly cleanup**",
    )
  })

  it('queues deploys and destroys of the same stack instead of racing them', () => {
    const { deploy, destroy } = loadWorkflow('stack-deploy.yml').jobs
    const perStack = { group: 'pulumi-stack-${{ inputs.stack_name }}', 'cancel-in-progress': false }
    expect(deploy?.concurrency).toEqual(perStack)
    expect(destroy?.concurrency).toEqual(perStack)
  })
})
