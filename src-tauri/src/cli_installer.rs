/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! One-click install of the standalone `thunderbolt` CLI.
//!
//! The desktop app derives per-release download URLs from its own version and the
//! scheme the CLI release pipeline defines (`.github/workflows/cli-release.yml`):
//!
//! ```text
//! https://github.com/thunderbird/thunderbolt/releases/download/v{version}/thunderbolt-cli-{target}
//! https://github.com/thunderbird/thunderbolt/releases/download/v{version}/SHA256SUMS
//! ```
//!
//! It downloads the binary and the `SHA256SUMS` manifest, checks the binary's
//! digest against the manifest before touching the filesystem (hard-fail on
//! mismatch), then installs it into `~/.local/bin/thunderbolt` via an atomic
//! rename. Every failure is a typed [`CliInstallError`] the UI renders honestly —
//! in particular a release predating the CLI pipeline yields
//! [`CliInstallError::NotPublished`], never a silent fallback.
//!
//! **What the checksum does and does not guarantee.** The binary and `SHA256SUMS`
//! are fetched from the same release host over the same TLS channel, so the digest
//! check only catches transport corruption and tampering *within* the manifest — it
//! adds no integrity against a compromised release host, since whoever can swap the
//! binary can swap its recorded digest too. There is no code signature, and on macOS
//! [`strip_quarantine`] removes the download quarantine so Gatekeeper never assesses
//! the (unsigned) binary. A detached signature (minisign) over the manifest, verified
//! against a pinned public key, is the known follow-up hardening.

use serde::Serialize;
use std::path::PathBuf;

/// Where prebuilt CLI binaries and their checksum manifest live.
const RELEASE_BASE: &str = "https://github.com/thunderbird/thunderbolt/releases/download";

/// Typed install failure. Each variant maps to a distinct UI message; `Unsupported`
/// and `NotPublished` additionally drive the "build from source instead" fallback.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum CliInstallError {
    /// This platform has no prebuilt binary (Intel macOS, Windows, mobile).
    Unsupported(String),
    /// The release or its CLI assets don't exist yet — e.g. a build predating the
    /// CLI release pipeline. Nothing to retry; it's simply not published.
    NotPublished(String),
    /// The download failed (network, TLS, or an unexpected HTTP status).
    Download(String),
    /// The downloaded binary's SHA-256 didn't match the manifest — install aborted.
    ChecksumMismatch(String),
    /// Writing the verified binary into place failed.
    Install(String),
}

impl From<std::io::Error> for CliInstallError {
    fn from(err: std::io::Error) -> Self {
        CliInstallError::Install(err.to_string())
    }
}

/// A successful install, as rendered by the settings UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallResult {
    /// Absolute path the binary was installed to (`~/.local/bin/thunderbolt`).
    pub path: String,
    /// Whether `~/.local/bin` is already on the user's `PATH`.
    pub on_path: bool,
    /// Shell line that puts the install dir on `PATH`; present only when
    /// `on_path` is false so the UI can show the one-liner the user still needs.
    pub path_hint: Option<String>,
}

/// The release asset slug for `(os, arch)`, or `None` on platforms with no
/// prebuilt binary. Mirrors the `cli-release.yml` build matrix exactly: only
/// `darwin-arm64`, `linux-x64` and `linux-arm64` are published — Intel macOS has
/// no iroh addon, and Windows/mobile aren't built.
fn resolve_target(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

/// The release asset filename for a target (matches the `SHA256SUMS` entries).
fn asset_name(target: &str) -> String {
    format!("thunderbolt-cli-{target}")
}

fn binary_url(version: &str, target: &str) -> String {
    format!("{RELEASE_BASE}/v{version}/thunderbolt-cli-{target}")
}

fn checksums_url(version: &str) -> String {
    format!("{RELEASE_BASE}/v{version}/SHA256SUMS")
}

/// Extract the expected lowercase hex digest for `asset` from a `sha256sum`-format
/// manifest (`<hex>  <filename>`, two spaces in text mode or ` *` in binary mode).
/// Returns `None` when no line names the asset exactly.
fn expected_sha_for(manifest: &str, asset: &str) -> Option<String> {
    manifest.lines().find_map(|line| {
        let (hash, name) = line.split_once(char::is_whitespace)?;
        let name = name.trim_start_matches([' ', '*']);
        (name == asset).then(|| hash.to_ascii_lowercase())
    })
}

/// Lowercase hex SHA-256 of `bytes`.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Whether `dir` appears in a `:`-separated `PATH` string (trailing slashes ignored).
fn is_dir_on_path(path_var: &str, dir: &str) -> bool {
    fn normalize(s: &str) -> &str {
        s.trim_end_matches('/')
    }
    let target = normalize(dir);
    path_var.split(':').any(|entry| normalize(entry) == target)
}

/// `~/.local/bin` — the XDG-conventional per-user binary dir.
fn local_bin_dir() -> Result<PathBuf, CliInstallError> {
    let home = std::env::var_os("HOME").ok_or_else(|| {
        CliInstallError::Install("HOME environment variable is not set".to_string())
    })?;
    Ok(PathBuf::from(home).join(".local").join("bin"))
}

/// Write `bytes` to `~/.local/bin/thunderbolt` with mode `0755` via a same-dir temp
/// file plus atomic rename, so a partial write never leaves a broken binary in
/// place. Returns the final installed path.
fn install_binary(bytes: &[u8]) -> Result<PathBuf, CliInstallError> {
    let dir = local_bin_dir()?;
    std::fs::create_dir_all(&dir)?;

    let final_path = dir.join("thunderbolt");
    // Same-dir temp keeps the rename atomic (both ends on one filesystem) and
    // pid-scoped so concurrent installs can't clobber each other's temp.
    let tmp_path = dir.join(format!(".thunderbolt.{}.tmp", std::process::id()));

    std::fs::write(&tmp_path, bytes)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755))?;
    }

    std::fs::rename(&tmp_path, &final_path)?;
    Ok(final_path)
}

/// Remove the download-quarantine xattr macOS applies to files fetched by
/// sandboxed apps, so Gatekeeper won't block the unsigned CLI. We write the file
/// ourselves so it usually has no such attribute — a missing attr is not an error.
#[cfg(target_os = "macos")]
fn strip_quarantine(path: &std::path::Path) {
    let _ = std::process::Command::new("/usr/bin/xattr")
        .args(["-d", "com.apple.quarantine"])
        .arg(path)
        .output();
}

/// GET `url`, mapping a 404 to [`CliInstallError::NotPublished`] (release/asset
/// absent) and any other non-success status or transport error to
/// [`CliInstallError::Download`].
async fn fetch(client: &reqwest::Client, url: &str) -> Result<reqwest::Response, CliInstallError> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| CliInstallError::Download(e.to_string()))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(CliInstallError::NotPublished(
            "This release has no prebuilt Thunderbolt CLI yet. Build it from source instead."
                .to_string(),
        ));
    }
    if !response.status().is_success() {
        return Err(CliInstallError::Download(format!(
            "Unexpected HTTP status {} downloading {url}",
            response.status()
        )));
    }
    Ok(response)
}

/// Download, verify and install the CLI for the given app `version`. See the
/// module docs for the URL scheme and verification contract.
pub async fn install_cli(version: &str) -> Result<CliInstallResult, CliInstallError> {
    let target = resolve_target(std::env::consts::OS, std::env::consts::ARCH).ok_or_else(|| {
        CliInstallError::Unsupported(
            "No prebuilt Thunderbolt CLI is published for this platform. Build it from source instead."
                .to_string(),
        )
    })?;

    // reqwest's rustls stack needs a process-default crypto provider. Install the
    // same aws-lc-rs provider the rest of the app uses — idempotent, so this is a
    // no-op if a provider is already set.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    // `connect_timeout` bounds only the TCP/TLS handshake; `timeout` is the overall
    // per-request deadline covering the body transfer, so a host that accepts the
    // connection then stalls mid-download surfaces as `Download` instead of hanging
    // the one-click-install spinner forever. Sized generously (10 min) since the
    // binary is ~90MB and must still complete over a slow-but-progressing link.
    let client = reqwest::Client::builder()
        .user_agent(concat!("thunderbolt/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| CliInstallError::Download(e.to_string()))?;

    // Fetch the manifest first: if the release predates the CLI pipeline this 404s
    // and we stop before downloading the (also-missing) binary.
    let manifest = fetch(&client, &checksums_url(version))
        .await?
        .text()
        .await
        .map_err(|e| CliInstallError::Download(e.to_string()))?;

    let expected = expected_sha_for(&manifest, &asset_name(target)).ok_or_else(|| {
        CliInstallError::NotPublished(format!(
            "This release publishes no CLI binary for {target}. Build it from source instead."
        ))
    })?;

    let bytes = fetch(&client, &binary_url(version, target))
        .await?
        .bytes()
        .await
        .map_err(|e| CliInstallError::Download(e.to_string()))?;

    let actual = sha256_hex(&bytes);
    if actual != expected {
        return Err(CliInstallError::ChecksumMismatch(format!(
            "Checksum mismatch for {}: expected {expected}, got {actual}. Install aborted.",
            asset_name(target)
        )));
    }

    let path = install_binary(&bytes)?;

    #[cfg(target_os = "macos")]
    strip_quarantine(&path);

    let dir = local_bin_dir()?;
    let dir_str = dir.to_string_lossy();
    let on_path = std::env::var("PATH").is_ok_and(|p| is_dir_on_path(&p, &dir_str));
    let path_hint = (!on_path).then(|| "export PATH=\"$HOME/.local/bin:$PATH\"".to_string());

    Ok(CliInstallResult {
        path: path.to_string_lossy().to_string(),
        on_path,
        path_hint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_target_maps_published_platforms() {
        assert_eq!(resolve_target("macos", "aarch64"), Some("darwin-arm64"));
        assert_eq!(resolve_target("linux", "x86_64"), Some("linux-x64"));
        assert_eq!(resolve_target("linux", "aarch64"), Some("linux-arm64"));
    }

    #[test]
    fn resolve_target_rejects_unpublished_platforms() {
        // Intel macOS has no iroh addon; Windows/mobile aren't built.
        assert_eq!(resolve_target("macos", "x86_64"), None);
        assert_eq!(resolve_target("windows", "x86_64"), None);
        assert_eq!(resolve_target("android", "aarch64"), None);
        assert_eq!(resolve_target("ios", "aarch64"), None);
    }

    #[test]
    fn urls_follow_the_release_scheme() {
        assert_eq!(
            binary_url("0.1.105", "darwin-arm64"),
            "https://github.com/thunderbird/thunderbolt/releases/download/v0.1.105/thunderbolt-cli-darwin-arm64"
        );
        assert_eq!(
            checksums_url("0.1.105"),
            "https://github.com/thunderbird/thunderbolt/releases/download/v0.1.105/SHA256SUMS"
        );
    }

    #[test]
    fn asset_name_matches_the_binary_filename() {
        assert_eq!(asset_name("linux-x64"), "thunderbolt-cli-linux-x64");
    }

    #[test]
    fn expected_sha_parses_text_mode_manifest() {
        let manifest = "\
aaaa1111  thunderbolt-cli-darwin-arm64
bbbb2222  thunderbolt-cli-linux-x64
cccc3333  thunderbolt-cli-linux-arm64
";
        assert_eq!(
            expected_sha_for(manifest, "thunderbolt-cli-linux-x64"),
            Some("bbbb2222".to_string())
        );
    }

    #[test]
    fn expected_sha_parses_binary_mode_and_lowercases() {
        // sha256sum binary mode uses ` *filename`; digests are compared lowercase.
        let manifest = "ABCD1234 *thunderbolt-cli-darwin-arm64\n";
        assert_eq!(
            expected_sha_for(manifest, "thunderbolt-cli-darwin-arm64"),
            Some("abcd1234".to_string())
        );
    }

    #[test]
    fn expected_sha_returns_none_for_absent_or_partial_names() {
        let manifest = "aaaa1111  thunderbolt-cli-linux-x64-old\n";
        // Must match the asset exactly, not as a prefix of another entry.
        assert_eq!(
            expected_sha_for(manifest, "thunderbolt-cli-linux-x64"),
            None
        );
        assert_eq!(expected_sha_for("", "thunderbolt-cli-linux-x64"), None);
    }

    #[test]
    fn sha256_hex_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn is_dir_on_path_detects_membership() {
        let path = "/usr/bin:/home/u/.local/bin:/opt/bin";
        assert!(is_dir_on_path(path, "/home/u/.local/bin"));
        assert!(!is_dir_on_path(path, "/home/u/bin"));
    }

    #[test]
    fn is_dir_on_path_ignores_trailing_slashes() {
        assert!(is_dir_on_path(
            "/usr/bin:/home/u/.local/bin/",
            "/home/u/.local/bin"
        ));
        assert!(is_dir_on_path("/home/u/.local/bin", "/home/u/.local/bin/"));
    }

    #[test]
    fn is_dir_on_path_handles_empty_path() {
        assert!(!is_dir_on_path("", "/home/u/.local/bin"));
    }
}
