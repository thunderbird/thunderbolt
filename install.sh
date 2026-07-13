#!/bin/sh

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Downloads and installs a released thunderbolt CLI binary.
set -eu

repository="thunderbird/thunderbolt"
api_url="https://api.github.com/repos/${repository}/releases"
releases_url="https://github.com/${repository}/releases/download"
source_instructions="https://github.com/${repository}/blob/main/cli/README.md#from-source"

fail() {
  echo "thunderbolt installer: error: $*" >&2
  exit 1
}

if command -v curl >/dev/null 2>&1; then
  downloader="curl"
elif command -v wget >/dev/null 2>&1; then
  downloader="wget"
else
  fail "curl or wget is required."
fi
[ -n "${HOME:-}" ] || fail "HOME is not set; cannot determine the install directory."

fetch() {
  case "${downloader}-${3:-}" in
    curl-api)
      curl -fsSL \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "${1}" -o "${2}"
      ;;
    curl-*)
      curl -fsSL "${1}" -o "${2}"
      ;;
    wget-api)
      wget -q \
        --header="Accept: application/vnd.github+json" \
        --header="X-GitHub-Api-Version: 2022-11-28" \
        "${1}" -O "${2}"
      ;;
    wget-*)
      wget -q "${1}" -O "${2}"
      ;;
  esac
}

os=$(uname -s)
arch=$(uname -m)

case "${os}-${arch}" in
  Darwin-arm64 | Darwin-aarch64)
    target="darwin-arm64"
    ;;
  Linux-x86_64)
    target="linux-x64"
    ;;
  Linux-arm64 | Linux-aarch64)
    target="linux-arm64"
    ;;
  Darwin-x86_64)
    fail "Intel macOS has no prebuilt CLI binary. Build from source: ${source_instructions}"
    ;;
  MINGW* | MSYS* | CYGWIN*)
    fail "Windows has no prebuilt CLI binary. Build from source: ${source_instructions}"
    ;;
  *)
    fail "unsupported platform ${os}/${arch}. Build from source: ${source_instructions}"
    ;;
esac

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/thunderbolt-install.XXXXXX") \
  || fail "could not create a temporary directory."
install_temp=""
cleanup() {
  rm -rf "${temp_dir}"
  if [ -n "${install_temp}" ]; then
    rm -f "${install_temp}"
  fi
}
trap cleanup 0 HUP INT TERM

resolve_latest_version() {
  releases_file="${temp_dir}/releases.json"
  : > "${releases_file}"
  page=1
  while :; do
    page_file="${temp_dir}/releases-${page}.json"
    if ! fetch "${api_url}?per_page=100&page=${page}" "${page_file}" api; then
      fail "could not query GitHub releases at ${api_url}"
    fi

    release_count=$(grep -c '^[[:space:]]*"tag_name"[[:space:]]*:' "${page_file}" || true)
    [ "${release_count}" -gt 0 ] || break
    cat "${page_file}" >> "${releases_file}"
    [ "${release_count}" -eq 100 ] || break
    page=$((page + 1))
  done

  version=$(awk '
    /^[[:space:]]*"tag_name"[[:space:]]*:/ {
      tag = $0
      sub(/^.*"tag_name"[[:space:]]*:[[:space:]]*"/, "", tag)
      sub(/".*$/, "", tag)
      draft = ""
      prerelease = ""
      next
    }
    tag != "" && /^[[:space:]]*"draft"[[:space:]]*:[[:space:]]*false/ {
      draft = "false"
      next
    }
    tag != "" && /^[[:space:]]*"draft"[[:space:]]*:[[:space:]]*true/ {
      draft = "true"
      next
    }
    tag != "" && /^[[:space:]]*"prerelease"[[:space:]]*:/ {
      prerelease = ($0 ~ /:[[:space:]]*false/) ? "false" : "true"
      next
    }
    tag != "" && /^[[:space:]]*"published_at"[[:space:]]*:/ {
      if (draft == "false" && prerelease == "false" && tag ~ /^v?[0-9]+\.[0-9]+\.[0-9]+$/) {
        published_at = $0
        sub(/^.*"published_at"[[:space:]]*:[[:space:]]*"/, "", published_at)
        sub(/".*$/, "", published_at)
        print published_at, tag
      }
      tag = ""
    }
  ' "${releases_file}" \
    | sort -r \
    | awk 'NR == 1 { print $2 }')

  [ -n "${version}" ] \
    || fail "GitHub API returned no stable semantic-version release. Set THUNDERBOLT_VERSION to a release tag and retry."
  printf '%s\n' "${version}"
}

if [ -n "${THUNDERBOLT_VERSION:-}" ]; then
  version="${THUNDERBOLT_VERSION}"
  printf '%s\n' "${version}" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+$' \
    || fail "THUNDERBOLT_VERSION must be a semantic-version release tag such as v0.1.107."
  case "${version}" in
    v*) ;;
    *) version="v${version}" ;;
  esac
else
  version=$(resolve_latest_version)
fi

binary_name="thunderbolt-${target}"
binary_file="${temp_dir}/${binary_name}"
checksums_file="${temp_dir}/SHA256SUMS"
download_url="${releases_url}/${version}"

if ! fetch "${download_url}/${binary_name}" "${binary_file}"; then
  fail "could not download ${download_url}/${binary_name}. Confirm release and platform assets exist."
fi
if ! fetch "${download_url}/SHA256SUMS" "${checksums_file}"; then
  fail "could not download ${download_url}/SHA256SUMS."
fi

checksum_line=$(awk -v name="${binary_name}" '$2 == name { print; exit }' "${checksums_file}")
[ -n "${checksum_line}" ] || fail "SHA256SUMS has no checksum for ${binary_name}."

if command -v shasum >/dev/null 2>&1; then
  if ! (cd "${temp_dir}" && printf '%s\n' "${checksum_line}" | shasum -a 256 -c -); then
    fail "checksum mismatch for ${binary_name}; downloaded file was not installed."
  fi
elif command -v sha256sum >/dev/null 2>&1; then
  if ! (cd "${temp_dir}" && printf '%s\n' "${checksum_line}" | sha256sum -c -); then
    fail "checksum mismatch for ${binary_name}; downloaded file was not installed."
  fi
else
  fail "no SHA-256 checker found. Install shasum or sha256sum, then retry."
fi

install_dir="${HOME}/.local/bin"
install_path="${install_dir}/thunderbolt"
mkdir -p "${install_dir}" || fail "could not create ${install_dir}."
install_temp=$(mktemp "${install_dir}/.thunderbolt.XXXXXX") \
  || fail "could not create a temporary file in ${install_dir}."
cp "${binary_file}" "${install_temp}" || fail "could not copy binary to ${install_dir}."
chmod +x "${install_temp}" || fail "could not make ${install_temp} executable."
mv "${install_temp}" "${install_path}" || fail "could not install ${install_path}."
install_temp=""

if [ "${os}" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "${install_path}" 2>/dev/null || true
fi

echo "installed: ${install_path} (${version}, ${target})"
case ":${PATH}:" in
  *":${install_dir}:"*) ;;
  *)
    echo "note: ${install_dir} is not on PATH; add this to your shell profile:"
    echo "      export PATH=\"${install_dir}:\$PATH\""
    ;;
esac
