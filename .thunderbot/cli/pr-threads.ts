import { gh, getRepo, getPRNodeId, parseRequiredPR, parseRequiredArg, runGraphQL, runGraphQLJSON } from './repo'

type ThreadComment = {
  id: string
  databaseId: number
  body: string
  path: string | null
  line: number | null
  author: { login: string }
}

type ReviewThread = {
  id: string
  isResolved: boolean
  comments: { nodes: ThreadComment[] }
}

type ThreadsSummary = {
  id: string
  isResolved: boolean
}

const THREADS_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100) {
        nodes { id isResolved comments(first: 10) { nodes { id databaseId body path line author { login } } } }
      }
    }
  }
}`

const THREADS_SUMMARY_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100) {
        nodes { id isResolved }
      }
    }
  }
}`

const RESOLVE_MUTATION = `mutation($id: ID!) {
  resolveReviewThread(input: {threadId: $id}) {
    thread { id }
  }
}`


/** Fetch all unresolved review threads with their comments for a PR */
export const getUnresolvedThreads = async (prNumber: number): Promise<ReviewThread[]> => {
  const nodeId = await getPRNodeId(prNumber)
  const result = await runGraphQLJSON<{
    node: { reviewThreads: { nodes: ReviewThread[] } }
  }>(THREADS_QUERY, { id: nodeId })

  return result.node.reviewThreads.nodes.filter((t) => !t.isResolved)
}

/** Fetch thread resolution summary (id + isResolved) for a PR */
export const getThreadsSummary = async (prNumber: number): Promise<ThreadsSummary[]> => {
  const nodeId = await getPRNodeId(prNumber)
  const result = await runGraphQLJSON<{
    node: { reviewThreads: { nodes: ThreadsSummary[] } }
  }>(THREADS_SUMMARY_QUERY, { id: nodeId })

  return result.node.reviewThreads.nodes
}

/** Resolve a single review thread by its GraphQL node ID */
export const resolveThread = async (threadId: string): Promise<void> => {
  await runGraphQL(RESOLVE_MUTATION, { id: threadId })
}

/** Resolve all unresolved review threads on a PR */
export const resolveAllThreads = async (prNumber: number): Promise<number> => {
  const threads = await getThreadsSummary(prNumber)
  const unresolved = threads.filter((t) => !t.isResolved)

  for (const thread of unresolved) {
    await resolveThread(thread.id)
  }

  return unresolved.length
}

/** Reply to a review thread comment using the REST API */
export const replyToThread = async (
  repo: string,
  prNumber: number,
  commentId: number,
  body: string,
): Promise<void> => {
  await gh([
    'api',
    `repos/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
    '-X',
    'POST',
    '-f',
    `body=${body}`,
  ])
}

/** CLI handler for pr-threads subcommand */
export const handlePRThreads = async (args: string[]): Promise<void> => {
  const prNumber = parseRequiredPR(args)
  const json = args.includes('--json')
  const resolveAll = args.includes('--resolve-all')
  const unresolved = args.includes('--unresolved')

  if (resolveAll) {
    const count = await resolveAllThreads(prNumber)
    if (json) {
      console.log(JSON.stringify({ resolved: count }))
    } else {
      console.log(`Resolved ${count} thread(s)`)
    }
    return
  }

  if (unresolved) {
    const threads = await getUnresolvedThreads(prNumber)
    if (json) {
      console.log(JSON.stringify(threads, null, 2))
    } else {
      if (threads.length === 0) {
        console.log('No unresolved threads')
        return
      }
      for (const thread of threads) {
        const firstComment = thread.comments.nodes[0]
        const location = firstComment?.path
          ? `${firstComment.path}${firstComment.line ? `:${firstComment.line}` : ''}`
          : '(no file)'
        console.log(`\n--- Thread ${thread.id} [${location}] ---`)
        for (const comment of thread.comments.nodes) {
          console.log(`  @${comment.author.login} (db:${comment.databaseId}): ${comment.body.slice(0, 200)}`)
        }
      }
    }
    return
  }

  // Default: show summary
  const threads = await getThreadsSummary(prNumber)
  const unresolvedCount = threads.filter((t) => !t.isResolved).length
  if (json) {
    console.log(JSON.stringify({ total: threads.length, unresolved: unresolvedCount }))
  } else {
    console.log(`${threads.length} thread(s), ${unresolvedCount} unresolved`)
  }
}

/** CLI handler for pr-reply subcommand */
export const handlePRReply = async (args: string[]): Promise<void> => {
  const prNumber = parseRequiredPR(args)
  const commentId = parseRequiredArg(args, '--comment-id', 'number') as number
  const body = parseRequiredArg(args, '--body', 'string') as string
  const repo = await getRepo()

  await replyToThread(repo, prNumber, commentId, body)
  console.log('Reply posted')
}

