#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Frontend startup banner — printed once at container start to remind the
# operator that this is a deployment and they need to verify they have
# rotated the default credentials. Constant (not detection-driven) — the
# backend is the layer that knows what's actually in use; this banner is
# belt-and-suspenders for surfaces where the backend logs aren't visible
# (e.g. someone scrolling docker-compose output past the backend startup).
#
# Suppress with DANGEROUSLY_ALLOW_DEFAULT_CREDS=true.
#
# This script runs as part of the official nginx image's
# /docker-entrypoint.d/ chain (executed in alphanumeric order before nginx
# starts).

set -e

case "${DANGEROUSLY_ALLOW_DEFAULT_CREDS:-}" in
  true|TRUE|True) exit 0 ;;
esac

DOCS_URL='https://github.com/thunderbird/thunderbolt/blob/main/deploy/README.md#default-credentials'

# Yellow background, black bold text. Echo to stderr so it doesn't get
# swallowed if anything pipes stdout.
{
  printf '\n\033[43;1;30m╔══════════════════════════════════════════════════════════════════════════════╗\033[0m\n'
  printf '\033[43;1;30m║                                                                              ║\033[0m\n'
  printf '\033[43;1;30m║   ⚠   Thunderbolt frontend — security reminder                               ║\033[0m\n'
  printf '\033[43;1;30m║                                                                              ║\033[0m\n'
  printf '\033[43;1;30m║   If this is a fresh deployment, verify you have rotated the default         ║\033[0m\n'
  printf '\033[43;1;30m║   credentials. The backend logs and the browser DevTools console will        ║\033[0m\n'
  printf '\033[43;1;30m║   list any defaults still in use.                                            ║\033[0m\n'
  printf '\033[43;1;30m║                                                                              ║\033[0m\n'
  printf '\033[43;1;30m║   Docs:                                                                      ║\033[0m\n'
  printf '\033[43;1;30m║   %-75s║\033[0m\n' "$DOCS_URL"
  printf '\033[43;1;30m║                                                                              ║\033[0m\n'
  printf '\033[43;1;30m║   Suppress: DANGEROUSLY_ALLOW_DEFAULT_CREDS=true                             ║\033[0m\n'
  printf '\033[43;1;30m║                                                                              ║\033[0m\n'
  printf '\033[43;1;30m╚══════════════════════════════════════════════════════════════════════════════╝\033[0m\n\n'
} >&2
