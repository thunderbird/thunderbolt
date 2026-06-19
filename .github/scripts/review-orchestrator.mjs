#!/usr/bin/env node

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// =============================================================================
// review-orchestrator.mjs
//
// Deterministic control loop for the advisory "thunder-deep-review" bot.
//
// WHY THIS EXISTS:
//   The workflow must NOT delegate orchestration to the model's tool-calls.
//   All GitHub I/O — polling A's bots, building the skip-list, computing the
//   resolved-diff, and posting the INLINE PR REVIEW — happens HERE, in
//   deterministic code. The model is invoked separately and emits STRUCTURED
//   JSON FINDINGS ONLY. This script reads that JSON, validates it, maps each
//   finding to a diff position, and posts it as one PR review with N inline
//   comments anchored to file:line (Bugbot-style).
//
// EXECUTION MODEL (two phases, see thunder-deep-review.yml):
//   Phase "pre":   poll A's bots  -> write skip-list + diff to files for the model step.
//   Phase "post":  read model JSON -> dedup vs our own open threads -> resolve
//                  our own fixed threads -> POST ONE PR REVIEW (event=COMMENT)
//                  with the NEW findings as inline comments.
//   Run as:  node review-orchestrator.mjs <pre|post>
//
// FAIL-SOFT (advisory): on ANY unrecoverable error we log and
//   process.exit(0) WITHOUT posting. A missing review is acceptable; a broken
//   or duplicate review is not. Next push retries.
//
// ZERO npm DEPENDENCIES: Node >=18 built-in global `fetch` only. No Octokit.
//
// ───────────────────────────────────────────────────────────────────────────
// IDENTITY: the orchestrator posts via the default GITHUB_TOKEN, so its review
//   comments are authored as `github-actions[bot]` — THUNDER_BOT_LOGIN resolves
//   to that (set in thunder-deep-review.yml). No separate GitHub App is needed.
//   The model-findings JSON path/contract is fixed via the THUNDER_*_FILE env
//   vars set in the workflow (see below).
// RESOLVED: EXPECTED_BOTS Cursor Bugbot app.id (1210556).
// =============================================================================

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// -----------------------------------------------------------------------------
// CONFIG / CONSTANTS
// -----------------------------------------------------------------------------

/**
 * EXPECTED_BOTS — the external "Job A" SaaS reviewers we sequence behind.
 *
 * Identify bots by NUMERIC `app.id`, NOT by login strings or
 * `app.slug` — logins ("cursor[bot]") and slugs drift, and a single app can
 * spawn multiple check-runs. The numeric id is stable.
 *
 * To find an app id: open a check-run that bot produced and GET its
 * `/repos/{owner}/{repo}/check-runs/{id}`, then read `.app.id`. Or hit
 * `/repos/{owner}/{repo}/commits/{sha}/check-runs` and read each run's `.app.id`.
 *
 * `loginHint` is ONLY used as a secondary, best-effort filter for review
 * COMMENTS (the comment author is a login, not an app id — see buildSkipList).
 *
 * Scope (Job A): Cursor Bugbot + GitHub Advanced Security only. CodeRabbit is
 * intentionally OUT of scope; add it back later by registering its app.id.
 */
const EXPECTED_BOTS = [
  // Cursor Bugbot — real numeric GitHub App id (slug "cursor", name "Cursor Bugbot").
  { name: 'cursor-bugbot', appId: 1210556, loginHint: 'cursor[bot]' },
];

// Identity of OUR OWN review comments, so we can dedup against / resolve only
// our own threads (never touch Bugbot's or a human's). The orchestrator runs
// under the default GITHUB_TOKEN, so the author login is github-actions[bot]
// (THUNDER_BOT_LOGIN, see env below). We also stamp every comment body with a
// hidden marker (SELF_COMMENT_MARKER) as the robust secondary signal.
const SELF_COMMENT_MARKER = '<!-- thunder-deep-review-finding -->';

// Severity enum the model output is validated against. Anything else is dropped.
const SEVERITY_ENUM = ['blocking', 'convention', 'nit'];

// Deterministic deep-mode gate. Diff bigger than this => deep mode.
const DEEP_MODE_CHANGED_LINES = 600; // tunable for the team's PR sizes.
const DEEP_MODE_FILE_COUNT = 40; // tunable for the team's PR sizes.
// Hard GitHub cliffs: /commits/{sha}/check-runs caps at 1000 check-suites,
// PR files list caps at 3000 files. Past the file cap we switch to bounded mode.
const PR_FILES_TRUNCATION_CAP = 3000;
// In bounded mode (PR exceeds the file cap) we deterministically clip the diff
// handed to the model to the first N per-file sections so "honor bounded mode"
// is a REAL scope limit, not just an unenforced prompt hint.
const BOUNDED_MODE_FILE_LIMIT = 200;

// Per-comment body length cap so a single inline comment never balloons.
const MAX_COMMENT_BODY = 60_000; // GitHub hard limit is 65536; leave headroom.
// Cap on inline comments per review so we never post a wall of nits.
const MAX_INLINE_COMMENTS = 50; // overflow rolls into the review summary body.

// Polling timing: jittered exponential backoff, honor Retry-After.
const POLL_BASE_MS = 15_000; // start at ~15s
const POLL_CAP_MS = 60_000; // cap at ~60s
const DISCOVERY_TIMEOUT_MS = 60_000; // ~60s: "never appeared" => treat bot as disabled
const COMPLETION_TIMEOUT_MS = 5 * 60_000; // ~5min: "exists but not completed yet"

// File handoff between the two phases / the model step.
// Paths come from the THUNDER_*_FILE env vars set in thunder-deep-review.yml.
const SKIPLIST_FILE = process.env.THUNDER_SKIPLIST_FILE ?? '/tmp/thunder-skiplist.json';
const DIFF_FILE = process.env.THUNDER_DIFF_FILE ?? '/tmp/thunder-diff.patch';
const FINDINGS_FILE = process.env.THUNDER_FINDINGS_FILE ?? '/tmp/thunder-findings.json';
const DEEPMODE_FILE = process.env.THUNDER_DEEPMODE_FILE ?? '/tmp/thunder-deepmode.json';

// -----------------------------------------------------------------------------
// ENVIRONMENT (read once, validated in main)
// -----------------------------------------------------------------------------

const env = {
  token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '',
  repoFull: process.env.GITHUB_REPOSITORY ?? '', // "owner/repo"
  prNumber: process.env.PR_NUMBER ?? '',
  // Reconcile EVERYTHING to the PR head SHA, never the synthetic merge ref.
  headSha: process.env.PR_HEAD_SHA ?? '',
  // GitHub PR action event name: "reopened" suppresses thread resolution.
  eventAction: process.env.PR_ACTION ?? '',
  apiBase: process.env.GITHUB_API_URL ?? 'https://api.github.com',
  graphqlBase: process.env.GITHUB_GRAPHQL_URL ?? 'https://api.github.com/graphql',
  // Login OUR review comments are authored as. The orchestrator posts via the
  // default GITHUB_TOKEN, so the author login is github-actions[bot]. The hidden
  // marker (SELF_COMMENT_MARKER) is the robust secondary match.
  selfLogin: process.env.THUNDER_BOT_LOGIN ?? 'github-actions[bot]',
  // Allow a `review:deep` label to force deep mode in addition to the size gate.
  hasDeepLabel: (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).includes('review:deep'),
};

const [owner, repo] = env.repoFull.split('/');

// -----------------------------------------------------------------------------
// SMALL UTILITIES
// -----------------------------------------------------------------------------

const log = (...args) => console.log('[thunder-orchestrator]', ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4)); // ±20%

/** Fail-soft exit: log the reason and exit 0 so the advisory bot never breaks CI. */
const failSoft = (reason, err) => {
  log('FAIL-SOFT (exiting 0 without posting):', reason, err?.message ?? '');
  process.exit(0);
};

/**
 * githubFetch — single choke-point for every GitHub REST call.
 *  - Sends auth + API version headers.
 *  - 4xx => throw immediately (bail; retrying won't help) EXCEPT 403/429 with a
 *    rate-limit signal, which we treat as retryable backoff.
 *  - 5xx => signal retryable so callers can back off.
 *  - Honors `Retry-After` and `x-ratelimit-reset` when rate-limited.
 * Returns { ok, status, json, linkHeader, retryAfterMs }.
 */
const githubFetch = async (url, init = {}) => {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'thunder-deep-review-orchestrator',
      // Declare the JSON body explicitly (matches graphqlFetch). Harmless on the
      // bodyless GETs; required so POSTs that send JSON.stringify(...) — the
      // create-review call — are parsed as JSON rather than mis-sniffed.
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const retryAfterMs = computeRetryAfterMs(res);
  const linkHeader = res.headers.get('link') ?? '';

  // Rate-limited: surface as retryable regardless of 403/429 framing. GitHub's
  // SECONDARY rate limit returns 403 with a `retry-after` header and a
  // remaining quota > 0 — treat that as retryable too, not a permanent 4xx.
  const remaining = res.headers.get('x-ratelimit-remaining');
  const isRateLimited =
    res.status === 429 ||
    (res.status === 403 && (remaining === '0' || res.headers.get('retry-after') !== null));

  if (res.status >= 500 || isRateLimited) {
    return { ok: false, retryable: true, status: res.status, json: null, linkHeader, retryAfterMs };
  }
  if (res.status >= 400) {
    // Non-rate-limit 4xx: permanent for this request. Caller decides bail vs ignore.
    const body = await res.text().catch(() => '');
    return { ok: false, retryable: false, status: res.status, json: null, linkHeader, retryAfterMs, body };
  }
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: true, retryable: false, status: res.status, json, linkHeader, retryAfterMs };
};

/** Parse Retry-After (seconds) or x-ratelimit-reset (epoch secs) into a ms delay. */
const computeRetryAfterMs = (res) => {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return secs * 1000;
  }
  const reset = res.headers.get('x-ratelimit-reset');
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (reset && remaining === '0') {
    const deltaMs = Number(reset) * 1000 - Date.now();
    if (Number.isFinite(deltaMs) && deltaMs > 0) return Math.min(deltaMs, POLL_CAP_MS);
  }
  return 0;
};

/** Follow RFC-5988 `Link: <url>; rel="next"` to paginate. */
const nextLink = (linkHeader) => {
  // e.g. <https://api...?page=2>; rel="next", <https://api...?page=9>; rel="last"
  const match = linkHeader.split(',').find((p) => p.includes('rel="next"'));
  if (!match) return null;
  const urlMatch = match.match(/<([^>]+)>/);
  return urlMatch ? urlMatch[1] : null;
};

/**
 * paginateAll — GET every page of a list endpoint, following Link headers.
 * Retries 5xx / rate-limit with jittered backoff; bails on hard 4xx.
 * `cap` guards against pathological pagination (e.g. the 3000-file cliff).
 */
const paginateAll = async (firstUrl, { cap = Infinity } = {}) => {
  const out = [];
  let url = firstUrl;
  let truncated = false;
  while (url) {
    // Retry budget is PER PAGE, not shared across the whole pagination —
    // otherwise a few flaky early pages exhaust the budget for all later ones.
    let attempt = 0;
    let r = await githubFetch(url);
    while (!r.ok && r.retryable && attempt < 5) {
      attempt += 1;
      await sleep(Math.max(r.retryAfterMs, jitter(Math.min(POLL_BASE_MS * 2 ** attempt, POLL_CAP_MS))));
      r = await githubFetch(url);
    }
    if (!r.ok) {
      throw new Error(`GET ${url} -> ${r.status} ${r.body ?? ''}`);
    }
    const page = Array.isArray(r.json) ? r.json : (r.json?.check_runs ?? []);
    out.push(...page);
    if (out.length >= cap) {
      truncated = true;
      break;
    }
    url = nextLink(r.linkHeader);
  }
  return { items: out, truncated };
};

const apiUrl = (path) => `${env.apiBase}/repos/${owner}/${repo}${path}`;

/**
 * graphqlFetch — single choke-point for the GraphQL calls we need (review-thread
 * resolution state + resolveReviewThread). Retries 5xx / rate-limit; returns
 * `{ ok, data, errors }`. Mutations that fail are fail-soft at the caller.
 */
const graphqlFetch = async (query, variables) => {
  let attempt = 0;
  for (;;) {
    const res = await fetch(env.graphqlBase, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'thunder-deep-review-orchestrator',
      },
      body: JSON.stringify({ query, variables }),
    });
    // Retry 5xx, 429, and GitHub's secondary rate limit (403 + retry-after).
    const secondaryLimited = res.status === 403 && res.headers.get('retry-after') !== null;
    if (res.status >= 500 || res.status === 429 || secondaryLimited) {
      if (attempt < 5) {
        attempt += 1;
        await sleep(Math.max(computeRetryAfterMs(res), jitter(Math.min(POLL_BASE_MS * 2 ** attempt, POLL_CAP_MS))));
        continue;
      }
      return { ok: false, data: null, errors: [{ message: `graphql ${res.status}` }] };
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) {
      return { ok: false, data: null, errors: body?.errors ?? [{ message: `graphql ${res.status}` }] };
    }
    return { ok: !body.errors?.length, data: body.data ?? null, errors: body.errors ?? null };
  }
};

// =============================================================================
// POLLER
// =============================================================================
//
// Enumerate the head-SHA check-runs ONCE, find the EXPECTED_BOTS runs by
// numeric app.id, then poll each existing run BY ID until status===completed
// (accept ANY conclusion). A short discovery sub-timeout treats "never
// appeared" as "bot disabled on this PR" (empty contribution) vs the full
// completion timeout for "run exists but hasn't finished yet".
//
// UNCHANGED by the inline-review redesign — only the comment SINK changed.
// =============================================================================

/** One enumeration of all check-runs for the head SHA (paginated). */
const listCheckRuns = async () => {
  // `filter=all` so we don't only see the latest run per app.
  const url = apiUrl(`/commits/${env.headSha}/check-runs?per_page=100&filter=all`);
  const { items } = await paginateAll(url);
  return items;
};

/**
 * pollForBots — block until all DISCOVERABLE expected bots reach completed,
 * or the relevant timeouts elapse. Returns the set of bot app.ids that
 * actually completed (used only for observability; the skip-list is built
 * from comments + outputs separately).
 */
const pollForBots = async () => {
  const start = Date.now();
  const expectedIds = new Set(EXPECTED_BOTS.map((b) => b.appId).filter((id) => id > 0));
  if (expectedIds.size === 0) {
    log('no real EXPECTED_BOTS app.ids configured — skipping poll, skip-list will be best-effort.');
    return;
  }

  let backoff = POLL_BASE_MS;
  // Track, per bot id: have we ever SEEN a run (discovery), and is it completed?
  const seen = new Set();
  const completed = new Set();

  for (;;) {
    let runs;
    try {
      runs = await listCheckRuns();
    } catch (err) {
      // Transient list failure: back off and retry within the overall window.
      if (Date.now() - start > COMPLETION_TIMEOUT_MS) {
        log('poll: completion timeout during list error — proceeding.', err.message);
        return;
      }
      await sleep(jitter(backoff));
      backoff = Math.min(backoff * 2, POLL_CAP_MS);
      continue;
    }
    // Successful list: reset the backoff so a few transient errors don't leave
    // us polling at the 60s cap for the rest of the discovery window.
    backoff = POLL_BASE_MS;

    for (const run of runs) {
      const appId = run.app?.id;
      if (!expectedIds.has(appId)) continue;
      seen.add(appId);
      if (run.status === 'completed') completed.add(appId); // ANY conclusion is terminal.
    }

    const elapsed = Date.now() - start;

    // Discovery sub-timeout: any expected bot we've NEVER seen after ~60s is
    // treated as disabled and dropped from the wait-set.
    const stillWaiting = [...expectedIds].filter((id) => {
      if (completed.has(id)) return false; // done
      if (!seen.has(id) && elapsed > DISCOVERY_TIMEOUT_MS) return false; // never appeared => disabled
      return true; // either seen-but-not-complete, or not-yet-seen within discovery window
    });

    if (stillWaiting.length === 0) {
      log(`poll: all discoverable bots terminal (completed=${[...completed].join(',') || 'none'}).`);
      return;
    }
    if (elapsed > COMPLETION_TIMEOUT_MS) {
      log(`poll: completion timeout (${Math.round(elapsed / 1000)}s) — proceeding with whatever posted.`);
      return;
    }

    await sleep(jitter(backoff));
    backoff = Math.min(backoff * 2, POLL_CAP_MS);
  }
};

// =============================================================================
// SKIP-LIST
// =============================================================================
//
// Build the "already reported by A" skip-list so the model surfaces only what
// A missed. Sources, in priority order:
//   1. PR review (inline) comments authored by the bots — AUTHORITATIVE.
//   2. The bots' check-run `output.text/summary` — BEST-EFFORT (free text).
// Dedup key is normalized on file + diff_hunk + side/original_line, NOT raw
// line numbers (lines drift on force-push).
//
// UNCHANGED by the inline-review redesign.
// =============================================================================

/** Stable dedup key for an inline comment. */
const dedupKeyFromReviewComment = (c) => {
  const parts = [
    c.path ?? '',
    // diff_hunk anchors the comment to surrounding code, resilient to line drift.
    (c.diff_hunk ?? '').trim().slice(0, 200),
    c.side ?? c.original_side ?? '',
    String(c.original_line ?? c.line ?? ''),
  ];
  return normalizeKey(parts.join(' '));
};

const normalizeKey = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/**
 * Is this review comment from one of our expected Job-A bots (Cursor Bugbot
 * et al.)? The skip-list MUST stay scoped to those external reviewers: pulling
 * in unrelated bots — especially THIS workflow's own `github-actions[bot]`
 * comments — would nudge the model to suppress its own prior findings, which
 * then trips the "missing hash ⇒ resolve thread" convergence on the next run.
 * Match an expected bot by its (drift-prone, best-effort) loginHint, and NEVER
 * count our own comments (selfLogin or the self marker).
 */
const isBotComment = (c) => {
  const login = c.user?.login ?? '';
  if (login === env.selfLogin || (c.body ?? '').includes(SELF_COMMENT_MARKER)) return false;
  return EXPECTED_BOTS.some((b) => b.loginHint && b.loginHint === login);
};

const buildSkipList = async () => {
  const entries = [];

  // 1) Inline review comments (authoritative). Paginate.
  try {
    const url = apiUrl(`/pulls/${env.prNumber}/comments?per_page=100`);
    const { items } = await paginateAll(url);
    for (const c of items) {
      if (!isBotComment(c)) continue;
      entries.push({
        key: dedupKeyFromReviewComment(c),
        source: 'inline',
        path: c.path,
        hunk: (c.diff_hunk ?? '').trim().slice(0, 200),
        summary: (c.body ?? '').slice(0, 280),
      });
    }
  } catch (err) {
    // Best-effort: a skip-list failure must not abort the whole review.
    log('skip-list: inline-comment fetch failed (continuing best-effort):', err.message);
  }

  // 2) Check-run outputs (best-effort, free text). We can't anchor these to a
  //    hunk, so we only record a coarse summary the model can defer to.
  try {
    const runs = await listCheckRuns();
    const expectedIds = new Set(EXPECTED_BOTS.map((b) => b.appId).filter((id) => id > 0));
    for (const run of runs) {
      if (!expectedIds.has(run.app?.id)) continue;
      const text = `${run.output?.title ?? ''}\n${run.output?.summary ?? ''}`.trim();
      if (!text) continue;
      entries.push({
        key: normalizeKey(`checkrun ${run.id}`),
        source: 'checkrun-summary',
        path: null,
        hunk: null,
        summary: text.slice(0, 600),
      });
    }
  } catch (err) {
    log('skip-list: check-run output fetch failed (continuing best-effort):', err.message);
  }

  // De-dup the skip-list itself by key.
  const byKey = new Map(entries.map((e) => [e.key, e]));
  return [...byKey.values()];
};

// =============================================================================
// DEEP-MODE GATE
// =============================================================================
//
// Compute diff size DETERMINISTICALLY in code; do NOT let the model decide
// when to spend on deep mode. Detect the 3000-file truncation cliff and fall
// back to a bounded mode flag the model honors.
//
// UNCHANGED by the inline-review redesign.
// =============================================================================

const computeDeepMode = async () => {
  let fileCount = 0;
  let changedLines = 0;
  let truncated = false;
  try {
    const url = apiUrl(`/pulls/${env.prNumber}/files?per_page=100`);
    const { items, truncated: t } = await paginateAll(url, { cap: PR_FILES_TRUNCATION_CAP });
    truncated = t;
    fileCount = items.length;
    for (const f of items) changedLines += (f.additions ?? 0) + (f.deletions ?? 0);
  } catch (err) {
    log('deep-mode: file list failed, defaulting to non-deep bounded:', err.message);
  }

  const sizeTriggered = changedLines >= DEEP_MODE_CHANGED_LINES || fileCount >= DEEP_MODE_FILE_COUNT;
  return {
    deepMode: env.hasDeepLabel || sizeTriggered,
    boundedMode: truncated, // past the file cap, review a bounded subset only.
    fileCount,
    changedLines,
    truncated,
    reason: env.hasDeepLabel ? 'review:deep label' : sizeTriggered ? 'size gate' : 'default single fan-out',
  };
};

// =============================================================================
// OUTPUT CONTRACT
// =============================================================================
//
// The model writes STRUCTURED JSON findings to FINDINGS_FILE. We NEVER trust
// raw model markdown. Validate severities against the enum, drop anything
// malformed, then render each finding into an inline comment body here.
//
// Expected JSON shape (the action step's prompt must enforce this):
//   { "findings": [ { "severity": "blocking"|"convention"|"nit",
//                     "file": "src/x.ts", "line": 42, "side": "RIGHT"|"LEFT",
//                     "title": "…", "body": "…", "rule": "optional-invariant-id" } ] }
// `side` is optional and defaults to RIGHT (the added/changed side). A finding
// whose line is not in the diff falls back to a file-level / summary comment.
// =============================================================================

/**
 * Stable per-finding hash, used to match a finding to an EXISTING open thread
 * across pushes (convergence). Anchored on file + normalized diff context + rule
 * + title — NOT raw line numbers (they drift on force-push). The `title` is what
 * separates two DISTINCT findings that share the same file, hunk, rule, and
 * severity; without it they collapse to one hash, so the second finding gets
 * dropped as "already open" and its feedback silently disappears. The model does
 * not emit a hunk, so we derive a coarse code anchor from the diff (see
 * hunkAnchorFor).
 */
const findingHash = (f) =>
  normalizeKey(
    [f.file ?? '', f.rule ?? '', (f.anchor ?? '').trim().slice(0, 200), f.severity, (f.title ?? '').trim()].join(' '),
  );

const readModelFindings = async () => {
  const raw = await readFile(FINDINGS_FILE, 'utf8');
  const parsed = JSON.parse(raw); // throws on malformed => fail-soft upstream.
  const list = Array.isArray(parsed?.findings) ? parsed.findings : [];
  // Validate + normalize. Drop anything with an out-of-enum severity.
  const valid = [];
  for (const f of list) {
    const severity = String(f.severity ?? '').toLowerCase();
    if (!SEVERITY_ENUM.includes(severity)) {
      log(`dropping finding with invalid severity: ${JSON.stringify(f.severity)}`);
      continue;
    }
    const side = String(f.side ?? 'RIGHT').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
    valid.push({
      severity,
      file: typeof f.file === 'string' ? f.file : null,
      // Valid diff lines are 1-based; reject <= 0 so a bad value falls back to
      // a file-level / summary placement rather than a never-matching line.
      line: Number.isFinite(f.line) && f.line >= 1 ? f.line : null,
      side,
      title: String(f.title ?? '').slice(0, 300),
      body: String(f.body ?? '').slice(0, 4000),
      rule: f.rule ? String(f.rule).slice(0, 80) : null,
    });
  }
  return valid;
};

// =============================================================================
// DIFF POSITION MAPPING
// =============================================================================
//
// The "create a review" REST API anchors inline comments with { path, line,
// side } (the line in the file at the head SHA). A comment can only attach to a
// line that is PART OF THE DIFF. We parse the unified diff (already produced
// deterministically into DIFF_FILE) to learn, per file, which (side, line)
// positions are commentable, and to capture a small code anchor per hunk so a
// finding can be matched across pushes even as line numbers drift.
// A finding whose line is NOT in the diff falls back to a file-level comment
// (subject_type=file) or, if even the file isn't in the diff, the review body
// summary — it NEVER crashes the post.
// =============================================================================

/**
 * parseUnifiedDiff — minimal unified-diff parser.
 * Returns Map<path, { rightLines:Set<number>, leftLines:Set<number>,
 *                     hunks: [{ rightStart, leftStart, text }] }>.
 * We only need membership ("is this line commentable?") and a per-hunk text
 * anchor; we do NOT need GitHub's legacy `position` integer (line+side is the
 * modern, drift-resilient anchor).
 */
const parseUnifiedDiff = (patch) => {
  const files = new Map();
  let current = null;
  let rightLine = 0;
  let leftLine = 0;
  let hunk = null;

  // Split on CRLF or LF — a trailing \r would otherwise get baked into the
  // hunk anchor text and destabilize the finding hash across pushes.
  const lines = patch.split(/\r?\n/);
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      current = null;
      hunk = null;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      // "+++ b/path" — the head-side path. "/dev/null" => deletion (no RIGHT side).
      const p = raw.slice(4).replace(/^b\//, '').trim();
      if (p === '/dev/null') {
        current = null;
        continue;
      }
      current = { rightLines: new Set(), leftLines: new Set(), hunks: [] };
      files.set(p, current);
      continue;
    }
    if (raw.startsWith('@@')) {
      // @@ -l,s +l,s @@ optional section heading
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!m || !current) {
        hunk = null;
        continue;
      }
      leftLine = Number(m[1]);
      rightLine = Number(m[2]);
      hunk = { rightStart: rightLine, leftStart: leftLine, text: raw };
      current.hunks.push(hunk);
      continue;
    }
    if (!current) continue;
    const tag = raw[0];
    if (tag === '+') {
      current.rightLines.add(rightLine);
      if (hunk) hunk.text += `\n${raw}`;
      rightLine += 1;
    } else if (tag === '-') {
      current.leftLines.add(leftLine);
      if (hunk) hunk.text += `\n${raw}`;
      leftLine += 1;
    } else if (tag === ' ') {
      // Context line (leading space): unchanged, but it IS part of the hunk and
      // GitHub accepts review comments on it ("unchanged lines shown for
      // context"). Record it on BOTH sides so a finding on a context line still
      // anchors inline instead of being needlessly demoted to a file comment.
      // ONLY a leading-space line counts — an empty token (the trailing split
      // artifact, or stray text outside a hunk) must NOT advance the counters or
      // be marked commentable, or it would falsely anchor a non-diff line.
      current.rightLines.add(rightLine);
      current.leftLines.add(leftLine);
      if (hunk) hunk.text += `\n${raw}`;
      rightLine += 1;
      leftLine += 1;
    }
    // tag === '\\' ("\ No newline at end of file") and empty/other tokens are
    // not content lines — skip without touching the line counters.
  }
  return files;
};

/** Load + parse the pre-computed diff. Best-effort: missing diff => empty map. */
const loadDiffIndex = async () => {
  try {
    const patch = await readFile(DIFF_FILE, 'utf8');
    return parseUnifiedDiff(patch);
  } catch (err) {
    log('diff: could not read/parse DIFF_FILE (all findings fall back to summary):', err.message);
    return new Map();
  }
};

/**
 * Deterministically clip a unified diff to its first `limit` per-file sections.
 * Each file section starts at a `diff --git ` line, so cutting on that boundary
 * always yields a still-valid patch (no half-file/half-hunk). Returns the
 * original patch unchanged when it has `limit` files or fewer.
 */
const clipDiffToFileLimit = (patch, limit) => {
  const lines = patch.split('\n');
  let fileCount = 0;
  const kept = [];
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      fileCount += 1;
      if (fileCount > limit) break;
    }
    kept.push(line);
  }
  return { clipped: fileCount > limit, fileCount: Math.min(fileCount, limit), text: kept.join('\n') };
};

/**
 * In bounded mode, rewrite DIFF_FILE in place to its first
 * BOUNDED_MODE_FILE_LIMIT file sections so the model gets a REAL, deterministic
 * scope — not just a prompt asking it to self-limit. No-op when not bounded or
 * the diff already fits. Best-effort: a read/write failure leaves the full diff.
 */
const enforceBoundedDiff = async (boundedMode) => {
  if (!boundedMode) return;
  try {
    const patch = await readFile(DIFF_FILE, 'utf8');
    const { clipped, fileCount, text } = clipDiffToFileLimit(patch, BOUNDED_MODE_FILE_LIMIT);
    if (!clipped) return;
    await writeFile(DIFF_FILE, text);
    log(`pre: bounded mode — clipped diff to first ${fileCount} files (${BOUNDED_MODE_FILE_LIMIT} cap).`);
  } catch (err) {
    log('pre: bounded-diff clip failed (continuing with full diff):', err.message);
  }
};

/**
 * Find the hunk in `fileEntry` that contains (side, line). Used to derive a
 * stable code anchor for the finding hash so convergence survives line drift.
 */
const stripHunkHeader = (text) => text.replace(/^@@.*@@.*/, '').trim().slice(0, 200);

const hunkAnchorFor = (fileEntry, line, side) => {
  if (!fileEntry) return '';
  // Pick the LAST hunk whose start is at/before the target line — that's the
  // one actually containing it. Picking the first (any start ≤ line) would
  // anchor a late-file finding to an early hunk and weaken cross-push
  // convergence. Coarse (first ~200 chars) on purpose — stability over exactness.
  let containing = null;
  for (const h of fileEntry.hunks) {
    const start = side === 'LEFT' ? h.leftStart : h.rightStart;
    if (line >= start) containing = h;
  }
  if (containing) {
    const anchor = stripHunkHeader(containing.text);
    if (anchor) return anchor;
  }
  return stripHunkHeader(fileEntry.hunks[0]?.text ?? '');
};

/**
 * Classify each finding against the diff index:
 *  - `inline`  : (side, line) is commentable → real anchored inline comment.
 *  - `file`    : file is in the diff but the line isn't → file-level comment.
 *  - `summary` : file not in the diff at all → rolled into the review body.
 * Also attaches a stable `anchor` (+ `hash`) for cross-push convergence.
 */
const classifyFindings = (findings, diffIndex) =>
  findings.map((f) => {
    const fileEntry = f.file ? diffIndex.get(f.file) : null;
    const lineSet = f.side === 'LEFT' ? fileEntry?.leftLines : fileEntry?.rightLines;
    const anchor = hunkAnchorFor(fileEntry, f.line ?? 0, f.side);
    const withAnchor = { ...f, anchor };
    const hash = findingHash(withAnchor);

    if (f.file && fileEntry && f.line != null && lineSet?.has(f.line)) {
      return { ...withAnchor, hash, placement: 'inline' };
    }
    if (f.file && fileEntry) {
      return { ...withAnchor, hash, placement: 'file' };
    }
    return { ...withAnchor, hash, placement: 'summary' };
  });

// =============================================================================
// OWN-THREAD STATE (dedup + resolution targets) — via GraphQL
// =============================================================================
//
// To converge across pushes we need, for OUR OWN review comments only:
//   - the stable finding-hash we stamped (read from a hidden HTML comment in
//     each comment body), and
//   - the review-thread node id + isResolved flag (REST review comments don't
//     expose thread/resolution; GraphQL `reviewThreads` does).
// We then: (a) skip posting a finding whose hash already has an OPEN own-thread
// (dedup), and (b) `resolveReviewThread` our own OPEN threads whose finding is
// gone from the current set (fixed/changed code).
// =============================================================================

/** Pull the stamped finding-hash out of one of our comment bodies, if present. */
const hashFromOwnBody = (body) => {
  const m = (body ?? '').match(/<!-- thunder-finding-hash:([0-9a-f]{8,}) -->/);
  return m ? m[1] : null;
};

/** Pull EVERY stamped finding-hash out of a body (a review body lists many). */
const hashesFromBody = (body) => [...(body ?? '').matchAll(/<!-- thunder-finding-hash:([0-9a-f]{8,}) -->/g)].map((m) => m[1]);

/**
 * Did WE author this review/comment? GraphQL returns a Bot author's login
 * WITHOUT the "[bot]" suffix ("github-actions"), while the REST-derived
 * selfLogin carries it ("github-actions[bot]") — normalize both before
 * comparing. The hidden SELF_COMMENT_MARKER is the canonical fallback.
 */
const isOwnAuthor = (login, body) =>
  login.replace(/\[bot\]$/, '') === env.selfLogin.replace(/\[bot\]$/, '') || (body ?? '').includes(SELF_COMMENT_MARKER);

/**
 * Fetch the finding-hashes we already SUMMARIZED in our own prior review bodies.
 * Summary/overflow findings never become review THREADS (they're body bullets,
 * not inline comments), so reviewThreads can't dedup them — without this each
 * push reposts the same "Additional notes". We stamp every summary bullet with a
 * hidden hash (see buildReviewPayload) and read them back here. Best-effort: a
 * GraphQL failure just means we may repost a summary line, never a crash.
 */
const fetchOwnSummarizedHashes = async () => {
  const query = `
    query($owner:String!, $repo:String!, $pr:Int!, $cursor:String) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$pr) {
          reviews(first:100, after:$cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { body author { login } }
          }
        }
      }
    }`;

  const out = new Set();
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential cursor pagination
    const r = await graphqlFetch(query, { owner, repo, pr: Number(env.prNumber), cursor });
    if (!r.ok || !r.data) {
      log('own-reviews: GraphQL fetch failed (summary dedup best-effort):', r.errors?.[0]?.message ?? '');
      return out;
    }
    const conn = r.data.repository?.pullRequest?.reviews;
    for (const node of conn?.nodes ?? []) {
      if (!isOwnAuthor(node.author?.login ?? '', node.body)) continue;
      for (const h of hashesFromBody(node.body)) out.add(h);
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
};

/**
 * Fetch OUR OWN review threads on this PR via GraphQL, paginated.
 * Returns [{ threadId, isResolved, hash }] where hash is the stamped finding
 * hash on the FIRST (root) comment of a thread we authored.
 */
const fetchOwnThreads = async () => {
  const query = `
    query($owner:String!, $repo:String!, $pr:Int!, $cursor:String) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$pr) {
          reviewThreads(first:100, after:$cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              isOutdated
              comments(first:1) {
                nodes { body author { login } }
              }
            }
          }
        }
      }
    }`;

  const out = [];
  let cursor = null;
  // Hard page cap (~1000 threads) so a stuck/looping endCursor can't spin forever.
  for (let page = 0; page < 10; page += 1) {
    const r = await graphqlFetch(query, {
      owner,
      repo,
      pr: Number(env.prNumber),
      cursor,
    });
    if (!r.ok || !r.data) {
      log('own-threads: GraphQL fetch failed (treating as no prior threads):', r.errors?.[0]?.message ?? '');
      return out;
    }
    const conn = r.data.repository?.pullRequest?.reviewThreads;
    for (const node of conn?.nodes ?? []) {
      const root = node.comments?.nodes?.[0];
      if (!root) continue;
      if (!isOwnAuthor(root.author?.login ?? '', root.body)) continue;
      out.push({
        threadId: node.id,
        isResolved: Boolean(node.isResolved),
        hash: hashFromOwnBody(root.body),
      });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
};

/** Mark one of OUR threads resolved. Fail-soft per call. */
const resolveThread = async (threadId) => {
  const mutation = `
    mutation($threadId:ID!) {
      resolveReviewThread(input:{threadId:$threadId}) {
        thread { id isResolved }
      }
    }`;
  const r = await graphqlFetch(mutation, { threadId });
  if (!r.ok) {
    log('resolve-thread: failed (continuing):', r.errors?.[0]?.message ?? threadId);
    return false;
  }
  return true;
};

// =============================================================================
// INLINE REVIEW RENDERING + POST
// =============================================================================
//
// Build ONE PR review: event=COMMENT (advisory — never approve/request-changes),
// commit_id=head SHA, comments=[{path, line, side, body}, ...]. Findings that
// can't anchor to a diff line are file-level comments (subject_type=file) or, if
// even the file isn't in the diff, summarized in the review body.
// =============================================================================

const SEVERITY_LABEL = { blocking: '🚫 Blocking', convention: '📐 Convention', nit: '🔧 Nit' };

/** Render one finding into an inline-comment markdown body (with hidden hash). */
const renderCommentBody = (f) => {
  // Rule/invariant ids (f.rule) are INTERNAL grounding only — used for the
  // dedup hash and the model's self-validation. They're meaningless to a human
  // in a PR comment, so they are never rendered into the comment body.
  const head = `**${SEVERITY_LABEL[f.severity]} — ${f.title}**`;
  const stamp = `\n\n${SELF_COMMENT_MARKER}<!-- thunder-finding-hash:${f.hash} -->`;
  const body = `${head}\n\n${f.body}${stamp}`;
  // Unreachable while readModelFindings caps title@300 + body@4000 (well under
  // MAX_COMMENT_BODY); kept intentionally in case those caps rise — not dead code.
  return body.length > MAX_COMMENT_BODY ? `${body.slice(0, MAX_COMMENT_BODY - stamp.length - 16)}\n…${stamp}` : body;
};

/**
 * Is this finding actually anchorable as an inline/file comment in the diff we
 * parsed? This is the SAME test GitHub applies server-side when it validates
 * `comments[]` on `POST /pulls/{n}/reviews`, so mirroring it here lets us demote
 * anything unanchorable to the summary body instead of risking a 422 that drops
 * the whole review.
 */
const isAnchorable = (f, diffIndex) => {
  const fileEntry = f.file ? diffIndex.get(f.file) : null;
  if (!fileEntry) return false; // file not in the real PR diff at all
  if (f.placement === 'file') return true; // file is in the diff → file-level ok
  const lineSet = f.side === 'LEFT' ? fileEntry.leftLines : fileEntry.rightLines;
  return f.line != null && Boolean(lineSet?.has(f.line));
};

/**
 * Build the review payload from the findings we decided to POST (already
 * deduped against open own-threads). Inline + file-level findings become
 * `comments[]`; summary-only findings (and inline overflow past the cap) roll
 * into the review `body`.
 *
 * RESILIENCE: an inline/file comment is added to `comments[]` ONLY if its
 * (path, line, side) is actually anchorable in the diff we parsed — re-verified
 * here against `diffIndex`, not just trusting the `placement` tag — so a stray
 * path/line can never reach GitHub as an inline comment and 422 the review.
 */
const buildReviewPayload = ({ toPost, diffIndex, deepInfo, skipCount }) => {
  const comments = [];
  const overflow = [];

  for (const f of toPost) {
    // Summary placements and anything not anchorable in the REAL diff roll into
    // the body so the POST can never 422 ("Path could not be resolved").
    if (f.placement === 'summary' || !isAnchorable(f, diffIndex)) {
      overflow.push(f);
      continue;
    }
    if (comments.length >= MAX_INLINE_COMMENTS) {
      overflow.push(f);
      continue;
    }
    const base = { path: f.file, body: renderCommentBody(f) };
    // file-level comment: subject_type=file, no line. Otherwise anchor by line+side.
    comments.push(f.placement === 'file' ? { ...base, subject_type: 'file' } : { ...base, line: f.line, side: f.side });
  }

  const summaryLines = [];
  for (const f of overflow) {
    const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
    // Trailing hidden hash so the NEXT run can see this summary finding was
    // already reported (summary findings have no thread, so reviewThreads can't
    // dedup them — fetchOwnSummarizedHashes reads these markers back).
    summaryLines.push(`- **${SEVERITY_LABEL[f.severity]}** ${loc} — ${f.title} <!-- thunder-finding-hash:${f.hash} -->`);
  }

  const header =
    `## 🔭 thunder-deep-review (advisory)\n` +
    `Complements the other bots — surfaces only what they did not flag. ` +
    `Never approves, never requests changes, never gates merge.\n` +
    `<sub>head: \`${env.headSha.slice(0, 12)}\` · mode: ${deepInfo.deepMode ? 'deep' : 'single'}` +
    `${deepInfo.boundedMode ? ' (bounded: diff exceeded file cap)' : ''} · ` +
    `deferred ${skipCount} item(s) already reported by other bots (best-effort dedup)</sub>\n`;

  const summaryBlock =
    summaryLines.length === 0
      ? ''
      : `\n### Additional notes (couldn't anchor to a diff line)\n${summaryLines.join('\n')}\n`;

  const body = `${header}${summaryBlock}`;
  return { event: 'COMMENT', commit_id: env.headSha, body, comments };
};

/** POST the review. event=COMMENT only — NEVER approve/request-changes. */
const postReview = async (payload) => {
  if (payload.comments.length === 0 && !payload.body.includes('Additional notes')) {
    // Nothing new to anchor and nothing to summarize beyond the header: still
    // post a thin review so absence-of-output isn't ambiguous, but only if we
    // actually have findings to show. With zero new findings we skip posting.
    log('post: no new inline comments and no summary items — skipping review post.');
    return;
  }
  const r = await githubFetch(apiUrl(`/pulls/${env.prNumber}/reviews`), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (r.ok) {
    log(`posted inline review: ${payload.comments.length} inline comment(s), event=COMMENT.`);
    return;
  }
  // Last-resort resilience: GitHub rejects the WHOLE review if ANY inline
  // comment can't be anchored ("Path could not be resolved"). Rather than lose
  // every good finding, retry ONCE with all inline comments dropped, folding
  // their locations into the summary body so the findings still reach the human.
  if (r.status === 422 && payload.comments.length > 0) {
    log(`post: 422 on inline anchors (${r.body ?? ''}) — retrying comment-free with findings in the body.`);
    const demoted = payload.comments.map((c) => {
      const lineRef = c.line ? `:${c.line}` : '';
      // Carry the hidden finding-hash from the inline body onto the demoted
      // bullet so the next run's summary-dedup (fetchOwnSummarizedHashes) sees
      // it and does not repost — otherwise this fallback path reintroduces the
      // "summary findings never dedupe" bug it is rescuing.
      const hash = hashFromOwnBody(c.body);
      const stamp = hash ? ` <!-- thunder-finding-hash:${hash} -->` : '';
      return `- \`${c.path}${lineRef}\` — ${c.body.split('\n')[0].replace(/\*\*/g, '')}${stamp}`;
    });
    const fallbackBody = `${payload.body}\n### Additional notes (couldn't anchor to a diff line)\n${demoted.join('\n')}\n`;
    const retry = await githubFetch(apiUrl(`/pulls/${env.prNumber}/reviews`), {
      method: 'POST',
      body: JSON.stringify({ event: 'COMMENT', commit_id: env.headSha, body: fallbackBody, comments: [] }),
    });
    if (!retry.ok) throw new Error(`create review retry failed: ${retry.status} ${retry.body ?? ''}`);
    log(`posted comment-free fallback review: ${demoted.length} finding(s) in body, event=COMMENT.`);
    return;
  }
  throw new Error(`create review failed: ${r.status} ${r.body ?? ''}`);
};

// =============================================================================
// PHASES
// =============================================================================

/** PRE phase: poll A's bots, then write the skip-list + deep-mode flag for the model step. */
const runPre = async () => {
  await pollForBots();
  const [skipList, deepInfo] = await Promise.all([buildSkipList(), computeDeepMode()]);
  await writeFile(SKIPLIST_FILE, JSON.stringify({ headSha: env.headSha, skipList }, null, 2));
  await writeFile(DEEPMODE_FILE, JSON.stringify(deepInfo, null, 2));
  // The DIFF_FILE itself is produced by a separate deterministic workflow step
  // (the GitHub API's PR diff, Accept: v3.diff — the exact merge-base..head set
  // GitHub validates review anchors against). This script never shells out to
  // git; it only does GitHub REST I/O. But when the PR overran the file cap we
  // clip that diff here so bounded mode is an ENFORCED scope, not a prompt hint.
  await enforceBoundedDiff(deepInfo.boundedMode);
  log(`pre: wrote ${skipList.length} skip-list entries; deepMode=${deepInfo.deepMode} (${deepInfo.reason}).`);
};

/**
 * POST phase: read validated model findings, map them to diff positions, dedup
 * against our own OPEN review threads, resolve our own FIXED threads, then post
 * ONE PR review (event=COMMENT) carrying only the NEW findings as inline
 * comments.
 */
const runPost = async () => {
  const rawFindings = await readModelFindings(); // throws => fail-soft
  let skipCount = 0;
  let deepInfo = { deepMode: false, boundedMode: false };
  try {
    skipCount = JSON.parse(await readFile(SKIPLIST_FILE, 'utf8')).skipList?.length ?? 0;
    deepInfo = JSON.parse(await readFile(DEEPMODE_FILE, 'utf8'));
  } catch {
    /* best-effort metadata only */
  }

  // 1) Map findings to diff positions (inline / file / summary) + stable hash.
  const diffIndex = await loadDiffIndex();
  const findings = classifyFindings(rawFindings, diffIndex);
  const currentHashes = new Set(findings.map((f) => f.hash));

  // 2) Fetch our own prior state: open inline THREADS (hash + resolution) and
  //    the hashes we already SUMMARIZED in prior review bodies. Summary findings
  //    have no thread, so without the latter each push reposts the same notes.
  const [ownThreads, summarizedHashes] = await Promise.all([fetchOwnThreads(), fetchOwnSummarizedHashes()]);
  const openHashes = new Set(ownThreads.filter((t) => !t.isResolved && t.hash).map((t) => t.hash));

  // 3) Dedup: post only findings NOT already present as an OPEN own-thread, and
  //    — for summary-placement findings, which have no thread — not already
  //    listed in a prior review's "Additional notes" body.
  const toPost = findings.filter((f) => !openHashes.has(f.hash) && !summarizedHashes.has(f.hash));

  // 4) Convergence: resolve our OWN open threads whose finding is gone now.
  //    Suppressed on `reopened` (the prior threads may be from another base).
  //    ALSO suppressed when the model emitted ZERO findings this run: an empty
  //    result is the model saying "nothing new to add" (the prompt tells it to
  //    return {"findings":[]} in that case), NOT "every prior finding is fixed".
  //    Without this guard an empty run would mark every open own-thread stale and
  //    resolve it even though the flagged code was never touched.
  if (env.eventAction === 'reopened') {
    log('post: reopened event — skipping thread resolution.');
  } else if (findings.length === 0) {
    log('post: model returned no findings — skipping thread resolution (no fix signal).');
  } else {
    const stale = ownThreads.filter((t) => !t.isResolved && t.hash && !currentHashes.has(t.hash));
    for (const t of stale) {
      // eslint-disable-next-line no-await-in-loop -- small N, ordered for clear logs
      await resolveThread(t.threadId);
    }
    if (stale.length) log(`post: resolved ${stale.length} own thread(s) whose finding is fixed.`);
  }

  // 5) Post the new findings as one inline review.
  const payload = buildReviewPayload({ toPost, diffIndex, deepInfo, skipCount });
  await postReview(payload);
};

// =============================================================================
// MAIN
// =============================================================================

const main = async () => {
  const phase = process.argv[2];
  if (!['pre', 'post'].includes(phase)) failSoft(`usage: review-orchestrator.mjs <pre|post> (got "${phase}")`);
  if (!env.token) failSoft('missing GITHUB_TOKEN/GH_TOKEN');
  if (!owner || !repo) failSoft(`missing/invalid GITHUB_REPOSITORY: "${env.repoFull}"`);
  if (!env.prNumber) failSoft('missing PR_NUMBER');
  if (!env.headSha) failSoft('missing PR_HEAD_SHA'); // must reconcile to head, not merge ref.

  try {
    if (phase === 'pre') await runPre();
    else await runPost();
  } catch (err) {
    failSoft(`unrecoverable error in ${phase} phase`, err);
  }
};

main();
