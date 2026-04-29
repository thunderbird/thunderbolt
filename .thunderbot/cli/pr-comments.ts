/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { gh, getRepo, parseRequiredPR, runGraphQL } from './repo'

type IssueComment = {
  id: number
  node_id: string
  body: string
  user: {
    login: string
    type: string
  }
  created_at: string
  updated_at: string
}

const MINIMIZE_MUTATION = `mutation($id: ID!) {
  minimizeComment(input: {subjectId: $id, classifier: RESOLVED}) {
    minimizedComment { isMinimized }
  }
}`

/**
 * Filter comments to only actionable ones.
 * Excludes bot comments and replies prefixed with the thunderbot marker.
 * This is the TypeScript equivalent of the issue_comments.jq filter.
 */
export const filterActionableComments = (comments: IssueComment[]): IssueComment[] =>
  comments.filter(
    (c) =>
      c.user.type === 'User' &&
      !c.body.startsWith('[Thunderbot]') &&
      !c.body.startsWith('\u26a1'),
  )

/** Fetch all issue-level comments for a PR */
export const getIssueComments = async (prNumber: number): Promise<IssueComment[]> => {
  const repo = await getRepo()
  const raw = await gh(['api', `repos/${repo}/issues/${prNumber}/comments`])
  return JSON.parse(raw) as IssueComment[]
}

/** Fetch only actionable issue-level comments (filtered) */
export const getActionableComments = async (prNumber: number): Promise<IssueComment[]> => {
  const all = await getIssueComments(prNumber)
  return filterActionableComments(all)
}

/** Minimize a comment by its GraphQL node ID */
export const minimizeComment = async (nodeId: string): Promise<void> => {
  await runGraphQL(MINIMIZE_MUTATION, { id: nodeId })
}

/** Minimize all actionable issue-level comments on a PR */
export const minimizeActionableComments = async (prNumber: number): Promise<number> => {
  const comments = await getActionableComments(prNumber)
  for (const comment of comments) {
    await minimizeComment(comment.node_id)
  }
  return comments.length
}


/** CLI handler for pr-comments subcommand */
export const handlePRComments = async (args: string[]): Promise<void> => {
  const prNumber = parseRequiredPR(args)
  const json = args.includes('--json')
  const actionable = args.includes('--actionable')

  const comments = actionable
    ? await getActionableComments(prNumber)
    : await getIssueComments(prNumber)

  if (json) {
    console.log(JSON.stringify(comments, null, 2))
  } else {
    if (comments.length === 0) {
      console.log(actionable ? 'No actionable comments' : 'No comments')
      return
    }
    for (const comment of comments) {
      console.log(`\n--- Comment #${comment.id} by @${comment.user.login} (${comment.user.type}) ---`)
      console.log(comment.body.slice(0, 300))
    }
  }
}

/** CLI handler for pr-minimize subcommand */
export const handlePRMinimize = async (args: string[]): Promise<void> => {
  const prNumber = parseRequiredPR(args)
  const count = await minimizeActionableComments(prNumber)
  console.log(`Minimized ${count} comment(s)`)
}

