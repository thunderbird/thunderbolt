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
//   All GitHub I/O — fetching the diff, deduping, and posting the INLINE
//   PR REVIEW — happens HERE, in
//   deterministic code. The model is invoked separately and emits STRUCTURED
//   JSON FINDINGS ONLY. This script reads that JSON, validates it, maps each
//   finding to a diff position, and posts it as one PR review with N inline
//   comments anchored to file:line (Bugbot-style).
//
// EXECUTION MODEL (see thunder-deep-review.yml):
//   Phase "pre":   write diff + mode flags to files for the model step.
//   Phase "post":  read model JSON -> dedup vs our own open threads ->
//                  POST ONE PR REVIEW (event=COMMENT)
//                  with the NEW findings as inline comments.
//   Phase "telemetry": log numeric model metrics after each model step.
//   Run as:  node review-orchestrator.mjs <pre|post|telemetry>
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
// =============================================================================

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// -----------------------------------------------------------------------------
// CONFIG / CONSTANTS
// -----------------------------------------------------------------------------

// Identity of OUR OWN review comments, so we can dedup against only
// our own threads (never touch Bugbot's or a human's). The orchestrator runs
// under the default GITHUB_TOKEN, so the author login is github-actions[bot]
// (THUNDER_BOT_LOGIN, see env below). The hidden marker identifies our format,
// but only the author login establishes ownership.
const SELF_COMMENT_MARKER = '<!-- thunder-deep-review-finding -->';
const REVIEW_HEAD_RE = /<!-- thunder-deep-review-head:([0-9a-f]{40}) -->/;

// Hidden marker on the affirmative "Reviewed — no issues found" review body. It
// lets the next run recognize that our LATEST own review is already the
// no-issues note and skip re-posting an identical one every push (so a clean PR
// converges to a single affirmative review, not a treadmill of duplicates). It
// also carries SELF_COMMENT_MARKER to identify the review format.
const NO_ISSUES_MARKER = '<!-- thunder-deep-review-no-issues -->';

// Severity enum the model output is validated against. Anything else is dropped.
// `critical` is the security dimension's top tier (above `blocking`): reserved for
// a finding the threat model rates Critical — a headline adversary (A1/A2/A3, NOT
// one who already holds the AK) breaks a confidentiality/takeover C-claim under
// cheap preconditions. Advisory still: it changes the label + ranking, never the
// merge gate. The ladder stays LINEAR so the precision gate can only ever demote
// down it (critical → blocking → convention → nit).
const SEVERITY_ENUM = ['critical', 'blocking', 'convention', 'nit'];

// Confidence enum for the model's INTERNAL precision-gate grounding field. An
// out-of-enum value normalizes to null — it never drops the finding (unlike an
// out-of-enum severity, which does).
const CONFIDENCE_ENUM = ['high', 'medium', 'low'];

// Deterministic deep-mode gate. Diff bigger than this => deep mode.
const DEEP_MODE_CHANGED_LINES = 600; // tunable for the team's PR sizes.
const DEEP_MODE_FILE_COUNT = 40; // tunable for the team's PR sizes.
const RETRY_BASE_MS = 15_000;
const RETRY_CAP_MS = 60_000;

// Crypto / E2EE paths that trigger the SECURITY dimension. Deterministic, like
// the deep-mode gate: code decides when the security lane spends, never the
// model. Matched against the PR's changed-file paths (repo-relative, exactly as
// the Files API returns them in `filename`). Keep in sync with the security-review
// surface list in docs/internals/architecture/e2ee-threat-model.md (the "Consumers" table).
const SECURITY_PATH_MATCHERS = [
  (p) => p.startsWith('src/crypto/'),
  (p) => p.startsWith('src/db/encryption/'),
  (p) => p.startsWith('backend/drizzle/'),
  (p) => p.startsWith('scripts/org-escrow-'),
  (p) => p === 'backend/src/api/encryption.ts',
  (p) => p === 'backend/src/api/powersync.ts',
  (p) => p === 'backend/src/lib/canary.ts',
  (p) => p === 'backend/src/lib/device-bind.ts',
  (p) => p === 'backend/src/lib/encrypted-payload.ts',
  (p) => p === 'backend/src/lib/step-up-otp.ts',
  (p) => p === 'shared/e2ee-types.ts',
  (p) => p === 'src/services/encryption.ts',
  (p) => p === 'src/db/powersync/middleware/EncryptionMiddleware.ts',
];
const GENERATED_CATALOG_OR_LOCKFILE_RE = /(?:^|\/)(?:[^/]+\.lock|package-lock\.json|locales\/(?:.*\/)?messages\.ts)$/;

/** Files whose patches contain only generated output. */
const isGeneratedFile = (filename) => GENERATED_CATALOG_OR_LOCKFILE_RE.test(filename) ||
  /^backend\/drizzle\/meta\/[^/]+_snapshot\.json$/.test(filename) || filename.startsWith('src/acp/iroh/pkg/');

/** Files whose volume should not trigger extra model passes. */
const excludesExtraPasses = (filename = '') =>
  (!filename?.startsWith('.claude/') && !/(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(filename) && /\.mdx?$/.test(filename)) ||
  /^docs\//.test(filename) ||
  GENERATED_CATALOG_OR_LOCKFILE_RE.test(filename) || /\.po$/.test(filename);

const matchesSecurityPath = (filename = '') =>
  !excludesExtraPasses(filename) && SECURITY_PATH_MATCHERS.some((m) => m(filename ?? ''));

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

// File handoff between the two phases / the model step.
// Paths come from the THUNDER_*_FILE env vars set in thunder-deep-review.yml.
const DIFF_FILE = process.env.THUNDER_DIFF_FILE ?? '/tmp/thunder-diff.patch';
const PR_DIFF_FILE = process.env.THUNDER_PR_DIFF_FILE ?? '/tmp/thunder-pr-diff.patch';
const PREVIOUS_FINDINGS_FILE = process.env.THUNDER_PREVIOUS_FINDINGS_FILE ?? '/tmp/thunder-previous-findings.json';
const FINDINGS_FILE = process.env.THUNDER_FINDINGS_FILE ?? '/tmp/thunder-findings.json';
const DEEPMODE_FILE = process.env.THUNDER_DEEPMODE_FILE ?? '/tmp/thunder-deepmode.json';

// -----------------------------------------------------------------------------
// ENVIRONMENT (read once, validated in main)
// -----------------------------------------------------------------------------

const labels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim());
const env = {
  token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '',
  repoFull: process.env.GITHUB_REPOSITORY ?? '', // "owner/repo"
  prNumber: process.env.PR_NUMBER ?? '',
  // Reconcile EVERYTHING to the PR head SHA, never the synthetic merge ref.
  headSha: process.env.PR_HEAD_SHA ?? '',
  // GitHub PR action event name: "reopened" suppresses affirmative no-issues notes.
  eventAction: process.env.PR_ACTION ?? '',
  apiBase: process.env.GITHUB_API_URL ?? 'https://api.github.com',
  graphqlBase: process.env.GITHUB_GRAPHQL_URL ?? 'https://api.github.com/graphql',
  // Login OUR review comments are authored as. The orchestrator posts via the
  // default GITHUB_TOKEN, so the author login is github-actions[bot].
  selfLogin: process.env.THUNDER_BOT_LOGIN ?? 'github-actions[bot]',
  // Allow a `review:deep` label to force deep mode in addition to the size gate.
  hasDeepLabel: labels.includes('review:deep'),
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
    if (Number.isFinite(deltaMs) && deltaMs > 0) return Math.min(deltaMs, RETRY_CAP_MS);
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
      await sleep(Math.max(r.retryAfterMs, jitter(Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS))));
      r = await githubFetch(url);
    }
    if (!r.ok) {
      throw new Error(`GET ${url} -> ${r.status} ${r.body ?? ''}`);
    }
    const page = r.json ?? [];
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
 * resolution state). Retries 5xx / rate-limit; returns
 * `{ ok, data, errors }`.
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
        await sleep(Math.max(computeRetryAfterMs(res), jitter(Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS))));
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
// DEEP-MODE GATE
// =============================================================================
//
// Compute diff size DETERMINISTICALLY in code; do NOT let the model decide
// when to spend on deep mode. Detect the 3000-file truncation cliff and fall
// back to a bounded mode flag the model honors.
//
// UNCHANGED by the inline-review redesign.
// =============================================================================

/**
 * Fetch the PR's changed files ONCE (paginated, capped at the 3000-file cliff) —
 * the single source that feeds BOTH the deep-mode size gate and the reconstructed
 * unified diff. Best-effort like the rest of the advisory bot: a hard failure
 * after retries yields an empty set, degrading the run to an empty-diff / non-deep
 * no-op instead of a red check (the next push retries).
 */
const fetchPrFiles = async () => {
  try {
    const url = apiUrl(`/pulls/${env.prNumber}/files?per_page=100`);
    return await paginateAll(url, { cap: PR_FILES_TRUNCATION_CAP });
  } catch (err) {
    log('pre: PR files fetch failed — degrading to empty diff / non-deep:', err.message);
    return { items: [], truncated: false };
  }
};

/** Use a completed ancestor's delta only when the compare response covers every file. */
const selectReviewScope = async (prFiles, ownReviewBodies) => {
  const full = { ...prFiles, incremental: false };
  if (env.eventAction !== 'synchronize' || prFiles.truncated) return full;
  const reviewedSha = ownReviewBodies.map((body) => body.match(REVIEW_HEAD_RE)?.[1]).findLast(Boolean);
  if (!reviewedSha) return full;
  const comparison = await githubFetch(apiUrl(`/compare/${reviewedSha}...${env.headSha}`));
  const delta = comparison.json;
  // Compare files are capped at 300 even with pagination; never checkpoint a partial delta.
  if (!comparison.ok || delta?.merge_base_commit?.sha !== reviewedSha ||
      !['ahead', 'identical'].includes(delta.status) || !Array.isArray(delta.files) || delta.files.length >= 300 ||
      delta.commits.some((commit) => commit.parents.length > 1) || delta.total_commits > delta.commits.length) {
    log('pre: compare unavailable, non-ancestor, merged or capped — reviewing full PR.');
    return full;
  }
  return { items: delta.files, truncated: false, incremental: true };
};

/**
 * Deterministic deep-mode gate over the already-fetched file list: code, never
 * the model, decides when to spend on deep mode. `truncated` (past the 3000-file
 * cliff) flips bounded mode so the diff is clipped to a reviewable subset.
 */
const computeDeepMode = (files, truncated) => {
  const modeFiles = files.filter((file) => !excludesExtraPasses(file.filename));
  const fileCount = modeFiles.length;
  const changedLines = modeFiles.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  const sizeTriggered = changedLines >= DEEP_MODE_CHANGED_LINES || fileCount >= DEEP_MODE_FILE_COUNT;
  // Path-conditional security dimension: on iff the diff touches a crypto/E2EE
  // path. Independent of deep mode — a one-line change to canary.ts is small (no
  // deep mode) but still crypto-sensitive (security lane on).
  const sensitiveFiles = modeFiles.map((f) => f.filename).filter(matchesSecurityPath);
  return {
    deepMode: env.hasDeepLabel || sizeTriggered,
    boundedMode: truncated, // past the file cap, review a bounded subset only.
    securityMode: sensitiveFiles.length > 0,
    sensitiveFiles,
    fileCount,
    totalFileCount: files.length,
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
//   { "findings": [ { "severity": "critical"|"blocking"|"convention"|"nit",
//                     "file": "src/x.ts", "line": 42, "side": "RIGHT"|"LEFT",
//                     "title": "…", "body": "…", "rule": "optional-invariant-id",
//                     "confidence": "high"|"medium"|"low",
//                     "evidence": "quoted offending source line"|null } ] }
// `side` is optional and defaults to RIGHT (the added/changed side). A finding
// whose line is not in the diff falls back to a file-level / summary comment.
// `confidence` and `evidence` are INTERNAL-ONLY grounding for the precision
// gate: they are validated + carried through, but NEVER rendered into any
// human-facing comment body or summary bullet.
// =============================================================================

const normalizeKey = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/**
 * Stable per-finding hash, used to match a finding to an EXISTING open thread
 * across pushes (convergence). The discriminator is the finding's LIVENESS KEY
 * (`f.livenessKey`, computed in classifyFindings) — the same diff-evidence string
 * NOT the model-generated title or a coarse hunk slice:
 *   - inline finding → the OFFENDING LINE'S trimmed code (`code:<text>`). Stable
 *     even when the model rephrases its prose or a neighbouring hunk line changes
 *     (closes the hash-drift → duplicate gap), and per-line specific.
 *   - file-level finding (line-null but file IS in the diff) → `file:<path>`.
 *     Stable across prose drift.
 *   - summary finding (file not in the diff, never becomes a thread) → a
 *     `text:<title-or-body slice>` fallback. These dedup via the review-body
 *     hash markers, so a prose rephrase can re-key one — low-harm (a body bullet,
 *     not a thread) and the only case with no diff anchor to key on.
 *
 * The placement tag distinguishes the three key spaces (`code:`/`file:`/`text:`),
 * so an inline finding can never collide with a file-level one.
 *
 * SEVERITY-INVARIANT: severity is deliberately NOT hashed. The precision gate
 * is allowed to DEMOTE a finding's severity (critical→blocking,
 * blocking→convention, convention→nit) between runs, and the recall model can re-classify the same
 * issue across runs — either would re-key the thread and post a duplicate
 * comment for an issue that already has one. Confidence/evidence are likewise
 * excluded (internal grounding, drift-prone across runs). The residual-collision
 * trade-off below still applies: the same file+rule+liveness key at DIFFERENT
 * severities is the same issue collapsing to one hash, and the safe failure
 * mode is under-report.
 *
 * MIGRATION: threads stamped before this change carry old-format (severity-
 * bearing) hashes and re-key exactly once when re-flagged — the same accepted
 * one-time re-post path as the legacy liveness-key migration.
 *
 * RESIDUAL COLLISION: findings that share a namespaced key collapse to one hash
 * and the second is dropped — two inline findings on byte-identical trimmed code,
 * or two file-level findings on the same file, each with the same rule.
 * Rare and the safe failure mode (under-report); the
 * alternative — folding the model's drift-prone title back in — would reopen the
 * duplicate gap this design exists to close, so we accept it.
 */
const findingHash = (f) =>
  normalizeKey([f.file ?? '', f.rule ?? '', f.livenessKey ?? ''].join(' '));

/**
 * normalizeFindings — validate + normalize the already-JSON.parsed model output
 * into the array of usable findings. Extracted from readModelFindings as a PURE
 * function (no fs/env) so the trust-boundary validation — the model's output is
 * untrusted input — is unit-testable in isolation. Drops anything with an
 * out-of-enum severity; every other bad field degrades to a safe default
 * instead of dropping the finding.
 */
const normalizeFindings = (parsed) => {
  const list = Array.isArray(parsed?.findings) ? parsed.findings : [];
  const valid = [];
  for (const f of list) {
    const severity = String(f.severity ?? '').toLowerCase();
    if (!SEVERITY_ENUM.includes(severity)) {
      log(`dropping finding with invalid severity: ${JSON.stringify(f.severity)}`);
      continue;
    }
    const side = String(f.side ?? 'RIGHT').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
    // Internal-only precision-gate fields. A bad value normalizes to null but
    // NEVER drops the finding — precision grounding is advisory, not identity.
    const confidence = String(f.confidence ?? '').toLowerCase();
    const evidence = typeof f.evidence === 'string' && f.evidence.trim() ? f.evidence.slice(0, 1000) : null;
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
      confidence: CONFIDENCE_ENUM.includes(confidence) ? confidence : null,
      evidence,
    });
  }
  return valid;
};

const readModelFindings = async () => {
  const raw = await readFile(FINDINGS_FILE, 'utf8');
  const parsed = JSON.parse(raw); // throws on malformed => fail-soft upstream.
  return normalizeFindings(parsed);
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
 *                     rightSeq:[{line,text}], leftSeq:[{line,text}] }>.
 * Membership Sets answer "is this (side, line) commentable?". `rightSeq`/`leftSeq`
 * carry each commentable line's TRIMMED code (tag stripped) in HUNK ORDER — the
 * per-line discriminator the finding hash
 * key on, and the ordering a short/common line (`}`, `return;`) walks to extend
 * its liveness key into a distinctive multi-line window (see livenessWindowFor,
 * findingHash). We do NOT need GitHub's legacy `position`
 * integer (line+side is the modern anchor).
 */
const parseUnifiedDiff = (patch) => {
  const files = new Map();
  let current = null;
  let rightLine = 0;
  let leftLine = 0;
  let inHunk = false;

  // Split on CRLF or LF — a trailing \r would otherwise get baked into the
  // line text and destabilize the finding hash / liveness key across pushes.
  const lines = patch.split(/\r?\n/);
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      current = null;
      inHunk = false;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      // "+++ b/path" — the head-side path. "/dev/null" => deletion (no RIGHT side).
      const p = raw.slice(4).replace(/^b\//, '').trim();
      if (p === '/dev/null') {
        current = null;
        continue;
      }
      current = {
        rightLines: new Set(),
        leftLines: new Set(),
        rightSeq: [],
        leftSeq: [],
      };
      files.set(p, current);
      continue;
    }
    if (raw.startsWith('@@')) {
      // @@ -l,s +l,s @@ optional section heading
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!m || !current) {
        inHunk = false;
        continue;
      }
      leftLine = Number(m[1]);
      rightLine = Number(m[2]);
      inHunk = true;
      continue;
    }
    if (!current || !inHunk) continue;
    const tag = raw[0];
    // Trimmed code content (tag stripped) — the per-line discriminator.
    const content = raw.slice(1).trim();
    if (tag === '+') {
      current.rightLines.add(rightLine);
      current.rightSeq.push({ line: rightLine, text: content });
      rightLine += 1;
    } else if (tag === '-') {
      current.leftLines.add(leftLine);
      current.leftSeq.push({ line: leftLine, text: content });
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
      current.rightSeq.push({ line: rightLine, text: content });
      current.leftSeq.push({ line: leftLine, text: content });
      rightLine += 1;
      leftLine += 1;
    }
    // tag === '\\' ("\ No newline at end of file") and empty/other tokens are
    // not content lines — skip without touching the line counters.
  }
  return files;
};

// Short structural tokens need surrounding context for a useful dedup key.
const MIN_DISTINCTIVE_CHARS = 12;

/**
 * Distinctiveness score of a candidate liveness key: the count of characters left
 * after stripping structural punctuation, whitespace, and ubiquitous keywords
 * (`return`/`else`/`const`/…). A line that reduces to almost nothing (`}`, `});`,
 * `} else {`) scores low and is too common to anchor a thread on its own; a line
 * with real identifiers scores high. Later re-flags derive the same window.
 */
const distinctiveness = (text) =>
  (text ?? '')
    .replace(/\b(?:return|else|const|let|var|await|async|function|if|for|while|case|break|continue)\b/g, '')
    .replace(/[\s{}()[\];,.:=>&|?!<+\-*/]/g, '')
    .length;

/** Build a distinctive evidence window for a stable per-finding dedup hash. */
const livenessWindowFor = (seq, line) => {
  const idx = seq.findIndex((e) => e.line === line);
  if (idx === -1 || !seq[idx].text) return '';
  // Grow a [lo, hi] window outward — forward first (toward the rest of the hunk),
  // then backward at a hunk's end — until it's distinctive enough or the lines are
  // exhausted. Join the window in source order so later re-flags derive the same key.
  let lo = idx;
  let hi = idx;
  const windowText = () => seq.slice(lo, hi + 1).map((e) => e.text).join('\n');
  while (distinctiveness(windowText()) < MIN_DISTINCTIVE_CHARS && (hi + 1 < seq.length || lo > 0)) {
    if (hi + 1 < seq.length) hi += 1;
    else lo -= 1;
  }
  // The whole available window is still non-distinctive → no trustworthy anchor;
  // fall back to the file-path key rather than hash a common token.
  return distinctiveness(windowText()) < MIN_DISTINCTIVE_CHARS ? '' : windowText();
};

/** Load the pre-computed diff index; a missing diff falls back to summary findings. */
const loadDiffIndex = async () => {
  try {
    const patch = await readFile(PR_DIFF_FILE, 'utf8');
    return parseUnifiedDiff(patch);
  } catch (err) {
    log('diff: could not read/parse PR_DIFF_FILE (all findings fall back to summary):', err.message);
    return new Map();
  }
};

/**
 * Reconstruct one file's section of a git unified diff from a List-pull-request-
 * files entry. The API's `patch` is the HUNK BODY ONLY (`@@ … @@` + content
 * lines); we prepend the `diff --git` + `---`/`+++` headers parseUnifiedDiff (and
 * GitHub's own review-anchor validator) key on, so the rebuilt section is faithful
 * enough that the SAME (path, line, side) anchors POST /pulls/{n}/reviews
 * validates round-trip exactly.
 *
 * `added`/`removed` carry `/dev/null` on the absent side, so a deleted file is
 * correctly NON-anchorable at head — parity with the real v3.diff. A file with no
 * `patch` (binary, or a text file GitHub omitted as too large — lockfiles,
 * generated snapshots) yields a HEADER-ONLY section: recorded as changed, but
 * with no commentable lines, exactly as the real diff truncates it.
 */
const fileSectionToDiff = (file) => {
  const newPath = file.filename;
  const oldPath = file.previous_filename ?? newPath;
  const header = `diff --git a/${oldPath} b/${newPath}`;
  if (!file.patch) return header;
  const fromTo =
    file.status === 'added'
      ? ['--- /dev/null', `+++ b/${newPath}`]
      : file.status === 'removed'
        ? [`--- a/${oldPath}`, '+++ /dev/null']
        : [`--- a/${oldPath}`, `+++ b/${newPath}`];
  return [header, ...fromTo, file.patch].join('\n');
};

/**
 * Reconstruct the PR's FULL unified diff from the List-pull-request-files API —
 * the path GitHub itself recommends when the `.diff` media type 406s past its
 * 20k-line / 1 MB cap (which silently broke this whole job on large PRs). The
 * files endpoint paginates and has no per-diff line cap, so it covers PRs the
 * `.diff` endpoint refuses; the only ceiling is the 3000-file cliff, already
 * handled by bounded mode. Concatenated `diff --git` sections — the exact shape
 * parseUnifiedDiff consumes.
 */
const buildUnifiedDiff = (files) => `${files.map(fileSectionToDiff).join('\n')}\n`;

/** Map findings to inline/file/summary placement and attach stable dedup hashes. */
const classifyFindings = (findings, diffIndex) =>
  findings.map((f) => {
    const fileEntry = f.file ? diffIndex.get(f.file) : null;
    const lineSet = f.side === 'LEFT' ? fileEntry?.leftLines : fileEntry?.rightLines;

    const place = (placement, livenessKey, discriminator) => ({
      ...f,
      placement,
      livenessKey,
      hash: findingHash({ ...f, livenessKey: discriminator }),
    });

    // Inline iff the (side, line) is commentable. Its liveness key is the
    // distinctiveness-checked window around the offending code when present; an
    // inline finding on a blank/empty line has no code to anchor, so it falls back
    // to the file path like a file-level one.
    if (f.file && fileEntry && f.line != null && lineSet?.has(f.line)) {
      const seq = f.side === 'LEFT' ? fileEntry.leftSeq : fileEntry.rightSeq;
      const window = livenessWindowFor(seq, f.line);
      return window
        ? place('inline', window, `code:${window}`)
        : place('inline', f.file, `file:${f.file}`);
    }
    if (f.file && fileEntry) {
      return place('file', f.file, `file:${f.file}`);
    }
    return place('summary', '', `text:${(f.title || f.body || '').trim().slice(0, 200)}`);
  });

// =============================================================================
// OWN-THREAD STATE (dedup + human dismissals) — via GraphQL
// =============================================================================
//
// To converge across pushes we need, for OUR OWN review comments only:
//   - the stable finding-hash we stamped (read from a hidden HTML comment in
//     each comment body), and
//   - the isResolved flag (REST review comments don't
//     expose thread/resolution; GraphQL `reviewThreads` does).
// Skip posting findings whose hashes already have open own-threads.
// =============================================================================

/** Pull the stamped finding-hash out of one of our comment bodies, if present. */
const hashFromOwnBody = (body) => {
  const m = (body ?? '').match(/<!-- thunder-finding-hash:([0-9a-f]{8,}) -->/);
  return m ? m[1] : null;
};

/** Pull EVERY stamped finding-hash out of a body (a review body lists many). */
const hashesFromBody = (body) => [...(body ?? '').matchAll(/<!-- thunder-finding-hash:([0-9a-f]{8,}) -->/g)].map((m) => m[1]);

/**
 * Is this login OURS? GraphQL returns a Bot login WITHOUT the "[bot]" suffix
 * ("github-actions"), while the REST-derived selfLogin carries it
 * ("github-actions[bot]") — normalize both before comparing.
 */
const isSelfLogin = (login) => login.replace(/\[bot\]$/, '') === env.selfLogin.replace(/\[bot\]$/, '');

/**
 * Does the LATEST of our own reviews say "no issues"? `bodies` is the list of
 * our own review bodies in chronological order (oldest→newest, the GraphQL
 * `reviews` connection default). We avoid re-posting an identical affirmative
 * note only when the most recent own review is ALREADY the no-issues note —
 * NOT merely when any prior one was (a real finding review since then means the
 * PR is no longer in a clean-and-acknowledged state, so a fresh "no issues" is
 * warranted once it's clean again). No own reviews yet => false (post the first
 * affirmative note). Pure for unit testing.
 */
const latestOwnReviewIsNoIssues = (bodies) => {
  const last = bodies.at(-1);
  return last != null && last.includes(NO_ISSUES_MARKER);
};

/**
 * Fetch our own prior REVIEW bodies in chronological order. Two consumers derive
 * from this without a second round-trip:
 *   - the set of finding-hashes we already SUMMARIZED (summary/overflow findings
 *     never become review THREADS, so reviewThreads can't dedup them — without
 *     this each push reposts the same "Additional notes"; we stamp every summary
 *     bullet with a hidden hash in buildReviewPayload and read them back here), and
 *   - whether our LATEST own review is the affirmative "no issues" note (so a
 *     clean PR doesn't re-post an identical note every push).
 * Best-effort: a GraphQL failure yields an empty list (we may repost a summary
 * line or the affirmative note, never a crash).
 */
const fetchOwnReviewBodies = async () => {
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

  const bodies = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential cursor pagination
    const r = await graphqlFetch(query, { owner, repo, pr: Number(env.prNumber), cursor });
    if (!r.ok || !r.data) {
      log('own-reviews: GraphQL fetch failed (summary dedup + no-issues best-effort):', r.errors?.[0]?.message ?? '');
      return bodies;
    }
    const conn = r.data.repository?.pullRequest?.reviews;
    for (const node of conn?.nodes ?? []) {
      // A copied marker in a human review must never become a checkpoint.
      if (!isSelfLogin(node.author?.login ?? '')) continue;
      bodies.push(node.body ?? '');
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return bodies;
};

/** Finding-hashes we already SUMMARIZED across our own prior review bodies. */
const summarizedHashesFromBodies = (bodies) => {
  const out = new Set();
  for (const body of bodies) for (const h of hashesFromBody(body)) out.add(h);
  return out;
};

/** Fetch own findings, replies and resolution state for recall context and post dedup. */
const fetchOwnThreads = async () => {
  const query = `
    query($owner:String!, $repo:String!, $pr:Int!, $cursor:String) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$pr) {
          reviewThreads(first:100, after:$cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id path line
              isResolved
              resolvedBy { login }
              comments(first:100) {
                pageInfo { hasNextPage endCursor }
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
      if (!isSelfLogin(root.author?.login ?? '')) continue;
      const comments = [...node.comments.nodes];
      let pageInfo = node.comments.pageInfo;
      while (pageInfo?.hasNextPage) {
        const replies = await graphqlFetch(`
          query($id:ID!, $cursor:String!) {
            node(id:$id) { ... on PullRequestReviewThread {
              comments(first:100, after:$cursor) {
                pageInfo { hasNextPage endCursor }
                nodes { body author { login } }
              }
            } }
          }`, { id: node.id, cursor: pageInfo.endCursor });
        if (!replies.ok || !replies.data?.node) {
          log('own-threads: reply page unavailable — keeping comments already loaded.');
          break;
        }
        comments.push(...replies.data.node.comments.nodes);
        pageInfo = replies.data.node.comments.pageInfo;
      }
      out.push({
        path: node.path,
        line: node.line,
        comments,
        isResolved: Boolean(node.isResolved),
        resolvedByLogin: node.resolvedBy?.login ?? null,
        hash: hashFromOwnBody(root.body),
      });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
};

/** Bound recall history while retaining dedup state outside the sanitized text. */
const buildPreviousFindings = (ownThreads, ownReviewBodies) => {
  const clean = (body) => body.replace(/<!--[\s\S]*?-->/g, '').slice(0, 2000);
  const history = {
    openThreadsRemain: ownThreads.some((t) => !t.isResolved),
    openHashes: ownThreads.filter((t) => !t.isResolved && t.hash).map((t) => t.hash),
    humanResolvedHashes: ownThreads.filter((t) => t.isResolved && t.hash &&
      t.resolvedByLogin && !isSelfLogin(t.resolvedByLogin)).map((t) => t.hash),
    ownThreads: ownThreads.map((thread) => ({ ...thread,
      comments: thread.comments.map((comment) => ({ ...comment, body: clean(comment.body) })),
    })),
    ownReviewBodies: ownReviewBodies.map(clean),
    summarizedHashes: [...summarizedHashesFromBodies(ownReviewBodies)],
    latestReviewNoIssues: latestOwnReviewIsNoIssues(ownReviewBodies),
  };
  // ponytail: bounded history drops oldest context; raise the cap if repeats become material.
  while (Buffer.byteLength(JSON.stringify(history)) > 100_000) {
    const resolved = history.ownThreads.findIndex((thread) => thread.isResolved);
    if (resolved !== -1) history.ownThreads.splice(resolved, 1);
    else if (history.ownReviewBodies.length > 0) history.ownReviewBodies.shift();
    else if (history.ownThreads.length > 0) history.ownThreads.shift();
    else if (history.summarizedHashes.length > 0) history.summarizedHashes.shift();
    else break;
  }
  return JSON.stringify(history);
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

const SEVERITY_LABEL = { critical: '🔴 Critical', blocking: '🚫 Blocking', convention: '📐 Convention', nit: '🔧 Nit' };

// Heading for body-summarized findings (summary placements + inline overflow +
// the 422 fallback). Single source so the skip-post check and the fallback's
// dedup-guard match the heading we actually emit.
const SUMMARY_HEADING = `### Additional notes (couldn't anchor to a diff line)`;

/**
 * The shared review-body header used by BOTH the findings review and the
 * affirmative no-issues note: the title, a `tagline` line that differs per
 * review type, the advisory disclaimer, and the `<sub>` run-metadata footer
 * (head sha · mode). Single source so the metadata format can
 * never drift between the two builders.
 */
const reviewHeader = ({ tagline, deepInfo }) =>
  `## 🔭 thunder-deep-review (advisory)\n` +
  `${tagline} ` +
  `Never approves, never requests changes, never gates merge.\n` +
  `<sub>head: \`${env.headSha.slice(0, 12)}\` · mode: ${deepInfo.deepMode ? 'deep' : 'single'}` +
  `${deepInfo.boundedMode ? ' (bounded: diff exceeded file cap)' : ''}</sub>\n` +
  // ponytail: converged runs keep the checkpoint; PUT needs raw review bodies beyond
  // the capped, sanitized history (>15 lines). Revisit if cumulative deltas stay costly.
  // Bounded reviews cannot certify coverage of the entire head.
  (deepInfo.boundedMode ? '' : `<!-- thunder-deep-review-head:${env.headSha} -->\n`);

/** Render one finding into an inline-comment markdown body (with hidden hash). */
const renderCommentBody = (f) => {
  // Rule/invariant ids (f.rule) are INTERNAL grounding only — used for the
  // dedup hash and the model's self-validation. They're meaningless to a human
  // in a PR comment, so they are never rendered into the comment body.
  // `confidence` and `evidence` are likewise internal-only (precision-gate
  // grounding) and intentionally not rendered.
  const head = `**${SEVERITY_LABEL[f.severity]} — ${f.title.replaceAll('<!--', '&lt;!--')}**`;
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
const buildReviewPayload = ({ toPost, diffIndex, deepInfo }) => {
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
    const loc = f.file ? `\`${f.file.replaceAll('<!--', '&lt;!--')}${f.line ? `:${f.line}` : ''}\`` : '';
    // Trailing hidden hash so the NEXT run can see this summary finding was
    // already reported (summary findings have no thread, so reviewThreads can't
    // dedup them — summarizedHashesFromBodies reads these markers back).
    summaryLines.push(`- **${SEVERITY_LABEL[f.severity]}** ${loc} — ${f.title.replaceAll('<!--', '&lt;!--')} <!-- thunder-finding-hash:${f.hash} -->`);
  }

  const header = reviewHeader({
    tagline: 'Reviews the diff for grounded findings.',
    deepInfo,
  });

  const summaryBlock =
    summaryLines.length === 0 ? '' : `\n${SUMMARY_HEADING}\n${summaryLines.join('\n')}\n`;

  const body = `${header}${summaryBlock}`;
  return { event: 'COMMENT', commit_id: env.headSha, body, comments };
};

/**
 * Build the affirmative "Reviewed — no issues found" review payload (Korbit-
 * style), posted when the precision gate returned a genuinely empty result so
 * silence reads as a completed review rather than a broken bot. event=COMMENT
 * with zero inline comments. It carries SELF_COMMENT_MARKER for the format and
 * NO_ISSUES_MARKER so the next run won't re-post an identical note.
 */
const buildNoIssuesPayload = ({ deepInfo }) => {
  const header = reviewHeader({ tagline: 'Reviewed the diff — no issues to report. ✅', deepInfo });
  const body = `${header}\n${SELF_COMMENT_MARKER}${NO_ISSUES_MARKER}`;
  return { event: 'COMMENT', commit_id: env.headSha, body, comments: [] };
};

/** POST the review. event=COMMENT only — NEVER approve/request-changes. */
const postReview = async (payload) => {
  if (payload.comments.length === 0 && !payload.body.includes(SUMMARY_HEADING)) {
    // Nothing to anchor inline and nothing to summarize beyond the header —
    // i.e. zero new findings. Skip posting entirely rather than leave a
    // contentless review on the PR.
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
      // bullet so the next run's summary-dedup (summarizedHashesFromBodies) sees
      // it and does not repost — otherwise this fallback path reintroduces the
      // "summary findings never dedupe" bug it is rescuing.
      const hash = hashFromOwnBody(c.body);
      const stamp = hash ? ` <!-- thunder-finding-hash:${hash} -->` : '';
      return `- \`${c.path}${lineRef}\` — ${c.body.split('\n')[0].replace(/\*\*/g, '')}${stamp}`;
    });
    // payload.body may ALREADY carry a SUMMARY_HEADING block (mixed-placement
    // reviews with summary findings) — append the demoted bullets under it
    // rather than emitting a duplicate header.
    const demotedBlock = demoted.join('\n');
    const fallbackBody = payload.body.includes(SUMMARY_HEADING)
      ? `${payload.body}${demotedBlock}\n`
      : `${payload.body}\n${SUMMARY_HEADING}\n${demotedBlock}\n`;
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

/**
 * POST the affirmative no-issues review. event=COMMENT, zero comments — bypasses
 * postReview's "nothing to say → skip" guard because an INTENTIONAL no-issues
 * note is exactly the content we want to leave when the gate cleared the diff.
 */
const postNoIssuesReview = async (payload) => {
  const r = await githubFetch(apiUrl(`/pulls/${env.prNumber}/reviews`), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`create no-issues review failed: ${r.status} ${r.body ?? ''}`);
  log('post: gate returned no findings — posted affirmative "no issues found" review.');
};

/**
 * Dedup the classified findings down to the subset worth POSTING this run: drop
 * any whose hash is already an OPEN own-thread, was human-resolved (respect the
 * decision), or was already summarized in a prior review body. Pure so the
 * gate-keeps-subset path is unit-testable end to end. The gate runs FIRST
 * (precision), so `findings` is already the kept subset; this is the convergence
 * dedup layered on top.
 */
const selectFindingsToPost = (findings, { openHashes, humanResolvedHashes, summarizedHashes }) =>
  findings.filter(
    (f) => !openHashes.has(f.hash) && !humanResolvedHashes.has(f.hash) && !summarizedHashes.has(f.hash),
  );

/**
 * Decide the terminal action for the post phase, given the gate's kept findings,
 * prior own-review bodies, whether any of our threads stay open, and the event.
 * Pure (no I/O) so both the gate-empty (affirmative no-issues) and
 * gate-keeps-subset (post inline) branches are unit-testable. Returns one of:
 *   - { action: 'no-issues' }            → post the affirmative note
 *   - { action: 'skip', reason }         → post nothing (already converged)
 *   - { action: 'post-findings' }        → post `toPost` as an inline review
 * The no-issues note is suppressed when a prior thread is still OPEN (the PR
 * isn't actually clean — posting "no issues" would contradict that thread),
 * when the latest own review is ALREADY that note, or on `reopened`.
 * runPost calls this (rather than inlining the branch) so logic and tests share
 * one source and can't drift.
 */
const decideTerminalAction = ({ findingCount, eventAction, ownReviewBodies, openThreadsRemain, diffAvailable = true,
  latestReviewNoIssues = latestOwnReviewIsNoIssues(ownReviewBodies) }) => {
  if (findingCount === 0) {
    // Never affirm "no issues" when we never actually had a diff to review. A
    // real PR always has ≥1 changed file, so an empty file set means the Files
    // API fetch failed (persistent 403/429/5xx) and runPre wrote an empty diff —
    // posting a clean review there would launder a broken run into fake green,
    // exactly the failure mode the loud-fail persist guards exist to prevent.
    // Skip silently; the next push retries with a real diff.
    if (!diffAvailable) return { action: 'skip', reason: 'diff-unavailable' };
    if (eventAction === 'reopened') return { action: 'skip', reason: 'reopened-no-findings' };
    if (openThreadsRemain) return { action: 'skip', reason: 'open-threads-remain' };
    if (latestReviewNoIssues) return { action: 'skip', reason: 'already-no-issues' };
    return { action: 'no-issues' };
  }
  return { action: 'post-findings' };
};

// =============================================================================
// PHASES
// =============================================================================

/** PRE phase: write the diff and mode flags for the model step. */
const runPre = async () => {
  const [prFiles, ownThreads, ownReviewBodies] = await Promise.all([
    fetchPrFiles(), fetchOwnThreads(), fetchOwnReviewBodies(),
  ]);
  const scope = await selectReviewScope(prFiles, ownReviewBodies);
  const diffFiles = scope.truncated ? scope.items.slice(0, BOUNDED_MODE_FILE_LIMIT) : scope.items;
  const reviewedFiles = diffFiles.filter((file) => !isGeneratedFile(file.filename));
  const omittedFiles = diffFiles.filter((file) => isGeneratedFile(file.filename)).map((file) => file.filename);
  const omittedNotice = omittedFiles.length ? `Generated files omitted from this patch: ${JSON.stringify(omittedFiles)}\n` : '';
  const deepInfo = { ...computeDeepMode(diffFiles, scope.truncated),
    incremental: scope.incremental, skip: reviewedFiles.length === 0 };
  await Promise.all([
    writeFile(DIFF_FILE, `${omittedNotice}${buildUnifiedDiff(reviewedFiles)}`),
    writeFile(PR_DIFF_FILE, buildUnifiedDiff(prFiles.items)),
    writeFile(PREVIOUS_FINDINGS_FILE, buildPreviousFindings(ownThreads, ownReviewBodies)),
    writeFile(DEEPMODE_FILE, JSON.stringify(deepInfo, null, 2)),
  ]);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `skip=${deepInfo.skip}\n`);
  log(`pre: wrote ${reviewedFiles.length}-file ${scope.incremental ? 'incremental' : 'full'} diff (${omittedFiles.length} generated files omitted); skip=${deepInfo.skip}; deepMode=${deepInfo.deepMode} (${deepInfo.reason}); securityMode=${deepInfo.securityMode} (${deepInfo.sensitiveFiles.length} crypto path(s)).`);
};

/**
 * POST phase: read validated model findings, map them to diff positions, dedup
 * against our own OPEN review threads, then post
 * ONE PR review (event=COMMENT) carrying only the NEW findings as inline
 * comments.
 */
const runPost = async () => {
  const rawFindings = await readModelFindings(); // throws => fail-soft
  let deepInfo = { deepMode: false, boundedMode: false };
  try {
    deepInfo = JSON.parse(await readFile(DEEPMODE_FILE, 'utf8'));
  } catch {
    /* best-effort metadata only */
  }
  // 1) Map findings to diff positions (inline / file / summary) + stable hash.
  const diffIndex = await loadDiffIndex();
  // Incremental LEFT lines refer to the previous head, not the PR's merge-base.
  const findings = classifyFindings(rawFindings.map((finding) =>
    deepInfo.incremental && finding.side === 'LEFT' ? { ...finding, line: null } : finding), diffIndex);

  // 2) Reuse the pre-phase snapshot also given to recall; no second history fetch.
  const { ownReviewBodies, openThreadsRemain, openHashes: priorOpenHashes,
    humanResolvedHashes: priorHumanResolvedHashes, summarizedHashes: priorHashes, latestReviewNoIssues } =
    JSON.parse(await readFile(PREVIOUS_FINDINGS_FILE, 'utf8'));
  const summarizedHashes = new Set(priorHashes);
  const openHashes = new Set(priorOpenHashes);
  // Preserve human dismissals rather than re-posting the same finding.
  const humanResolvedHashes = new Set(priorHumanResolvedHashes);

  // 3) Dedup: post only findings NOT already present as an OPEN own-thread, NOT
  //    human-resolved (respect the human's decision), and — for summary-placement
  //    findings, which have no thread — not already listed in a prior review's
  //    "Additional notes" body.
  const toPost = selectFindingsToPost(findings, { openHashes, humanResolvedHashes, summarizedHashes });

  // 4) Terminal action (computed by decideTerminalAction so logic ⇄ tests can't drift):
  //    - 'no-issues'     : gate cleared the diff AND no prior thread stays open →
  //                        post a Korbit-style "no issues found" note so silence
  //                        reads as a completed review. Suppressed when the
  //                        latest own review is ALREADY that note (a clean PR
  //                        converges to a single affirmative review), when a prior
  //                        thread is still open (the PR isn't actually clean), or
  //                        on `reopened` (ambiguous vs the prior base).
  //    - 'skip'          : already converged → post nothing.
  //    - 'post-findings' : post the NEW findings as one inline review (itself a
  //                        no-op inside postReview when dedup left nothing new).
  const decision = decideTerminalAction({
    findingCount: findings.length,
    eventAction: env.eventAction,
    ownReviewBodies,
    latestReviewNoIssues,
    openThreadsRemain,
    // A real PR always has ≥1 changed file; totalFileCount 0 (or a missing deep-mode
    // file) means the Files API fetch failed and the diff is empty — don't post
    // an affirmative "no issues" review off a diff we never actually got.
    diffAvailable: (deepInfo.totalFileCount ?? 0) > 0,
  });
  if (decision.action === 'no-issues') {
    await postNoIssuesReview(buildNoIssuesPayload({ deepInfo }));
    return;
  }
  if (decision.action === 'skip') {
    log(`post: gate returned no findings — skipping (${decision.reason}).`);
    return;
  }

  const payload = buildReviewPayload({ toPost, diffIndex, deepInfo });
  await postReview(payload);
};

/** Extract only numeric aggregates from the action's SDK event array. */
const summarizeExecution = (events) => {
  const result = events.findLast((event) => event.type === 'result');
  const number = (value) => Number.isFinite(value) && value >= 0 ? value : null;
  const models = Object.fromEntries(Object.entries(result?.modelUsage ?? {}).map(([model, usage]) => [
    /^claude-[a-z0-9.\[\]-]{1,80}$/.test(model) ? model : 'unknown',
    {
      costUsd: number(usage.costUSD),
      input: number(usage.inputTokens),
      output: number(usage.outputTokens),
      cacheRead: number(usage.cacheReadInputTokens),
      cacheCreation: number(usage.cacheCreationInputTokens),
    },
  ]));
  const calls = new Map();
  const seen = new Set();
  for (const event of events) {
    if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content) {
      if (block.type !== 'tool_use' || !['Agent', 'Task'].includes(block.name) || seen.has(block.id)) continue;
      seen.add(block.id);
      const type = block.input?.subagent_type ?? '';
      const label = /^[A-Za-z0-9_:-]{1,80}$/.test(type) ? type : 'unknown';
      calls.set(label, (calls.get(label) ?? 0) + 1);
    }
  }
  return {
    costUsd: number(result?.total_cost_usd),
    turns: number(result?.num_turns),
    models,
    agentCalls: Object.fromEntries(calls),
  };
};

// =============================================================================
// MAIN
// =============================================================================

/** Log bounded execution aggregates without exposing model content or failing CI. */
const runTelemetry = async () => {
  if (process.env.MODEL_OUTCOME === 'skipped') {
    console.warn('::warning::Model step skipped; no execution metrics');
    return;
  }
  try {
    const file = process.env.EXECUTION_FILE || join(process.env.RUNNER_TEMP, 'claude-execution-output.json');
    const events = JSON.parse(await readFile(file, 'utf8'));
    const summary = summarizeExecution(events);
    console.log(JSON.stringify(summary));
    if (summary.costUsd === null) console.warn('::warning::No result metrics in Claude execution file');
    if (Object.keys(summary.models).length === 0) console.warn('::warning::No modelUsage in Claude execution file');
  } catch (err) {
    console.warn(err.code === 'ENOENT'
      ? '::warning::Claude execution file absent; no execution metrics'
      : '::warning::Could not aggregate Claude execution metrics');
  }
};

const main = async () => {
  const phase = argv[2];
  if (phase === 'telemetry') return runTelemetry();
  if (!['pre', 'post'].includes(phase)) failSoft(`usage: review-orchestrator.mjs <pre|post|telemetry> (got "${phase}")`);
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

// Run only when executed directly (node review-orchestrator.mjs <pre|post>),
// not when imported by a test harness that exercises the pure helpers below.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) main();

// Helpers + constants exported for testing. The
// convergence + precision-gate terminal logic lives here — keep it covered.
export {
  paginateAll,
  graphqlFetch,
  summarizeExecution,
  parseUnifiedDiff,
  buildUnifiedDiff,
  computeDeepMode,
  matchesSecurityPath,
  normalizeFindings,
  findingHash,
  classifyFindings,
  selectFindingsToPost,
  decideTerminalAction,
  latestOwnReviewIsNoIssues,
  summarizedHashesFromBodies,
  buildReviewPayload,
  buildNoIssuesPayload,
  NO_ISSUES_MARKER,
  SUMMARY_HEADING,
};
