#!/bin/sh

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# install.sh — build (if needed) and install the `thunderbolt` binary into
# ~/.local/bin. POSIX sh; idempotent (re-running overwrites the install).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BINARY="${SCRIPT_DIR}/dist/thunderbolt"

if [ ! -f "${BINARY}" ]; then
  echo "thunderbolt: dist/thunderbolt missing — building…"
  (cd "${SCRIPT_DIR}" && bun run build)
fi

INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "${INSTALL_DIR}"
cp "${BINARY}" "${INSTALL_DIR}/thunderbolt"
chmod +x "${INSTALL_DIR}/thunderbolt"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "note: ${INSTALL_DIR} is not on your PATH — add it:" \
       && echo "      export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac

echo "installed: ${INSTALL_DIR}/thunderbolt"
