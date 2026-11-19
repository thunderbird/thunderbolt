#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Create Release Script
 *
 * Updates all version files, commits changes, and creates a git tag.
 * Used by GitHub Actions workflows and can be run locally for testing.
 *
 * Usage:
 *   bun run scripts/create-release.ts --version 1.2.3
 *   bun run scripts/create-release.ts --type minor
 *   bun run scripts/create-release.ts --type auto
 *   bun run scripts/create-release.ts --version 1.2.3 --dry-run
 *   bun run scripts/create-release.ts --platform all --push  # Used by CI
 */

import { spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

type VersionType = 'major' | 'minor' | 'patch' | 'auto'

const platforms = ['all', 'ios', 'android', 'desktop'] as const
type Platform = (typeof platforms)[number]

type Args = {
  version?: string
  type?: VersionType
  platform?: Platform
  dryRun?: boolean
  push?: boolean
  help?: boolean
}

const repoRoot = join(import.meta.dir, '..')
const versionPackagePaths = ['package.json', 'cli/package.json'] as const

// Fatal, because replacing an invalid byte with U+FFFD can make one ref name read as another,
// and ignoreBOM keeps a leading U+FEFF that belongs to a name
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// Git on macOS composes Unicode in its arguments, so a branch "rel-e" + U+0301 would be read as "rel-" + U+00E9
const exactRefNames = ['-c', 'core.precomposeUnicode=false']

/**
 * Run a program with an argument list and return its output without the final newline.
 * A silent call returns '' when the program exits nonzero; every other failure throws,
 * including output larger than maxBuffer (spawnSync's own 1 MiB default unless a caller needs more).
 */
const exec = (file: string, args: string[], silent = false, cwd = repoRoot, maxBuffer = 1024 * 1024): string => {
  // Safe: no shell runs, so ref names from the repository reach the program as plain arguments
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
  const result = spawnSync(file, args, { cwd, stdio: silent ? 'pipe' : 'inherit', maxBuffer })
  if (result.error) {
    throw result.error
  }
  if (result.status === 0) {
    // Not trim(): a valid ref name can end in characters it strips, such as U+00A0
    return utf8.decode(result.stdout ?? undefined).replace(/\n$/, '')
  }
  if (silent && result.signal === null) {
    return ''
  }
  throw new Error(`Command failed: ${[file, ...args].join(' ')}`)
}

/**
 * Parse command line arguments
 */
const parseArgs = (): Args => {
  const args: Args = {}

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]

    if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg === '--version' || arg === '-v') {
      args.version = process.argv[++i]?.replace(/^v/, '')
    } else if (arg === '--type' || arg === '-t') {
      args.type = process.argv[++i] as VersionType
    } else if (arg === '--platform') {
      args.platform = process.argv[++i] as Platform
    } else if (arg === '--dry-run' || arg === '-d') {
      args.dryRun = true
    } else if (arg === '--push' || arg === '-p') {
      args.push = true
    }
  }

  return args
}

/**
 * Show help message
 */
const showHelp = () => {
  console.log(`
Create Release Script

Updates all version files, commits changes, and creates a git tag.

Usage:
  bun run scripts/create-release.ts [options]

Options:
  -v, --version <version>   Specify exact version (e.g., 1.2.3)
  -t, --type <type>         Version bump type: major, minor, patch, or auto (default: auto)
  --platform <platform>     Target platform: all, ios, android, or desktop (default: all)
  -d, --dry-run             Show what would be done without making changes
  -p, --push                Push commit and tag to remote (default: local only)
  -h, --help                Show this help message

Examples:
  bun run scripts/create-release.ts                      # Auto-detect from commits
  bun run scripts/create-release.ts --push               # Auto-detect and push
  bun run scripts/create-release.ts --version 1.2.3
  bun run scripts/create-release.ts --version 1.2.3 --push
  bun run scripts/create-release.ts --type minor --push
  bun run scripts/create-release.ts --dry-run            # Preview changes

Auto-detection rules (default behavior):
  - major: Commits contain "BREAKING" or "!"
  - minor: Commits start with "feat" or "feature"
  - patch: Everything else (bug fixes, chores, etc.)

Note: By default, changes are committed and tagged locally only.
      Use --push to push to remote and trigger CI/CD.
`)
}

/**
 * Get current version from package.json
 */
const getCurrentVersion = (): string => {
  const pkgPath = join(repoRoot, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  return pkg.version
}

/**
 * Bump version based on type
 * Handles pre-release suffixes like '-desktop-rc', '-ios-rc' by stripping them first
 */
const bumpVersion = (current: string, type: 'major' | 'minor' | 'patch'): string => {
  // Strip any pre-release suffix (e.g., '-desktop-rc', '-ios-rc') before parsing
  const cleanVersion = current.split('-')[0]
  const parts = cleanVersion.split('.')

  if (parts.length !== 3) {
    throw new Error(`Invalid version format: ${current}. Expected X.Y.Z format.`)
  }

  const [major, minor, patch] = parts.map(Number)

  if ([major, minor, patch].some((n) => isNaN(n) || n < 0)) {
    throw new Error(`Invalid version numbers in: ${current}`)
  }

  switch (type) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
  }
}

// About a million typical tag lines, against a few hundred tags today, while still bounding memory
const tagListMaxBuffer = 64 * 1024 * 1024

/**
 * Get the nearest tag behind HEAD as a full ref (refs/tags/...), or '' when there is none.
 * git describe names an annotated tag by the name stored inside it, which need not be the ref that holds it,
 * so this exits when any annotated tag HEAD can reach is stored under another name.
 */
const getLastTagRef = (): string => {
  const tags = exec(
    'git',
    [...exactRefNames, 'for-each-ref', '--merged=HEAD', '--format=%(refname)%00%(objecttype)%00%(tag)', 'refs/tags'],
    true,
    repoRoot,
    tagListMaxBuffer,
  )
  const misnamed = tags
    .split('\n')
    .map((line) => line.split('\0'))
    .find(([ref, type, name]) => type === 'tag' && ref !== `refs/tags/${name}`)
  if (misnamed) {
    // JSON escapes any control characters, since only fsck stops them inside a tag object's name
    console.error(`❌ Error: ${misnamed[0]} holds an annotated tag named ${JSON.stringify(misnamed[2])}`)
    console.error('Rename or delete that ref, or pass --version or --type instead of auto')
    process.exit(1)
  }
  const name = exec('git', [...exactRefNames, 'describe', '--tags', '--abbrev=0'], true)
  // Fully qualified, so a tag named "-x", "HEAD", "@" or "refs/heads/main" still means that tag
  return name ? `refs/tags/${name}` : ''
}

/**
 * Auto-detect version type from commits
 */
const detectVersionType = (): 'major' | 'minor' | 'patch' => {
  const lastTagRef = getLastTagRef()

  // --encoding=UTF-8 overrides an i18n.logOutputEncoding that would print subjects the UTF-8 decoder rejects
  let commits: string
  if (lastTagRef) {
    commits = exec(
      'git',
      [...exactRefNames, 'log', '--encoding=UTF-8', '--pretty=format:%s', `${lastTagRef}..HEAD`],
      true,
    )
  } else {
    commits = exec('git', ['log', '--encoding=UTF-8', '--pretty=format:%s', '--reverse'], true)
  }

  // Check for breaking changes
  if (/breaking|!/i.test(commits)) {
    console.log('🔴 Breaking changes detected - major version bump')
    return 'major'
  }

  // Check for new features
  if (/^(feat|feature)/im.test(commits)) {
    console.log('🟡 New features detected - minor version bump')
    return 'minor'
  }

  // Default to patch
  console.log('🟢 Bug fixes and maintenance - patch version bump')
  return 'patch'
}

/**
 * Update a package version
 */
const updatePackageVersion = (version: string, relativePath: string) => {
  const path = join(repoRoot, relativePath)
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  pkg.version = version
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`  ✓ ${relativePath}: ${version}`)
}

/**
 * Update Cargo.toml version
 */
const updateCargoToml = (version: string) => {
  const path = join(repoRoot, 'src-tauri/Cargo.toml')
  let content = readFileSync(path, 'utf8')
  content = content.replace(/^version = ".*"/m, `version = "${version}"`)
  writeFileSync(path, content)
  console.log(`  ✓ src-tauri/Cargo.toml: ${version}`)
}

/**
 * Update Cargo.lock to reflect Cargo.toml changes
 */
const updateCargoLock = () => {
  console.log('  ⟳ Updating Cargo.lock...')
  try {
    exec('cargo', ['update', '--workspace'], true, join(repoRoot, 'src-tauri'))
    console.log(`  ✓ src-tauri/Cargo.lock: updated`)
  } catch {
    console.log(`  ⚠ src-tauri/Cargo.lock: could not update (cargo might not be installed)`)
  }
}

/**
 * Update tauri.conf.json version
 */
const updateTauriConf = (version: string) => {
  const path = join(repoRoot, 'src-tauri/tauri.conf.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  config.version = version
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  console.log(`  ✓ src-tauri/tauri.conf.json: ${version}`)
}

/**
 * Update iOS project.yml version (only for iOS-specific releases)
 * For unified releases, this is handled by ios-release.yml workflow
 */
const updateProjectYml = (version: string, platform: string) => {
  // Only update project.yml for iOS-specific releases
  if (platform !== 'ios') {
    console.log(`  ⊘ src-tauri/gen/apple/project.yml: skipped (handled by ios-release.yml)`)
    return
  }

  const path = join(repoRoot, 'src-tauri/gen/apple/project.yml')

  if (!existsSync(path)) {
    console.log(`  ⊘ src-tauri/gen/apple/project.yml: not found (skipped)`)
    return
  }

  let content = readFileSync(path, 'utf8')
  content = content.replace(/CFBundleShortVersionString: .*/, `CFBundleShortVersionString: ${version}`)
  content = content.replace(/CFBundleVersion: .*/, `CFBundleVersion: "${version}"`)
  writeFileSync(path, content)
  console.log(`  ✓ src-tauri/gen/apple/project.yml: ${version}`)
}

/**
 * Update Android tauri.properties versionName
 */
const updateTauriProperties = (version: string) => {
  const path = join(repoRoot, 'src-tauri/gen/android/app/tauri.properties')

  if (!existsSync(path)) {
    console.log(`  ⊘ src-tauri/gen/android/app/tauri.properties: not found (skipped)`)
    return
  }

  const content = readFileSync(path, 'utf8')
  const updated = content.replace(/tauri\.android\.versionName=.*/, `tauri.android.versionName=${version}`)
  writeFileSync(path, updated)
  console.log(`  ✓ src-tauri/gen/android/app/tauri.properties: ${version}`)
}

/**
 * Update all version files
 */
const updateVersionFiles = (version: string, platform: string) => {
  console.log('\n📝 Updating version files to', version)
  versionPackagePaths.forEach((path) => updatePackageVersion(version, path))
  updateCargoToml(version)
  updateCargoLock()
  updateTauriConf(version)
  updateProjectYml(version, platform)
  updateTauriProperties(version)

  if (platform === 'all') {
    console.log('\n  ℹ️  Note: Platform-specific versions handled by respective workflows:')
    console.log('     • iOS: project.yml updated by ios-release.yml')
    console.log('     • Android: versionCode calculated from git commit count')
  } else if (platform === 'android') {
    console.log('\n  ℹ️  Note: Android versionCode will be calculated from git commit count')
  }
}

/**
 * Check if git working directory is clean
 */
const isGitClean = (): boolean => {
  const status = exec('git', ['status', '--porcelain'], true)
  return status.length === 0
}

/**
 * Get the checked-out branch as a full ref (refs/heads/...), or exit when HEAD is not on a branch.
 * Pushing the full ref keeps a tag or branch named "HEAD", "-x" or "+main" from changing what gets pushed.
 */
const getCurrentBranchRef = (): string => {
  const ref = exec('git', [...exactRefNames, 'symbolic-ref', '--quiet', 'HEAD'], true)
  if (!ref.startsWith('refs/heads/') || ref === 'refs/heads/') {
    console.error('❌ Error: HEAD is not on a branch')
    console.error('Check out the branch to release from first')
    process.exit(1)
  }
  return ref
}

/**
 * Quote a value for a POSIX shell. Inside single quotes only ' is special, so each one becomes '\''
 */
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/**
 * Regenerate CHANGELOG.md from git history with the new version labeled.
 * Skipped for platform-specific RC releases (only unified releases update the changelog).
 * Requires `git-cliff` on PATH (install via `brew install git-cliff` or `cargo install git-cliff`).
 */
const generateChangelog = (version: string, platform: string) => {
  if (platform !== 'all') {
    console.log('  ⊘ CHANGELOG.md: skipped (RC release)')
    return
  }

  console.log('\n📝 Regenerating CHANGELOG.md')

  try {
    exec('git-cliff', ['--tag', `v${version}`, '-o', 'CHANGELOG.md'])
    console.log(`  ✓ CHANGELOG.md: labeled section as v${version}`)
  } catch (error) {
    console.error('\n❌ Error: git-cliff failed (or is not installed).')
    console.error('   Install via: brew install git-cliff (macOS) or cargo install git-cliff')
    throw error
  }
}

/**
 * Check if a tag exists (locally or remotely)
 */
const tagExists = (tagName: string): boolean => {
  try {
    // Check if tag exists locally
    const result = exec('git', ['rev-parse', '--verify', tagName], true)
    // If the command succeeds and returns a SHA, the tag exists
    return result.length > 0 && /^[0-9a-f]{40}$/i.test(result)
  } catch {
    // Tag doesn't exist locally, check remote
    try {
      const output = exec('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tagName}`], true)
      return output.length > 0
    } catch {
      return false
    }
  }
}

/**
 * Commit and tag the version
 */
const commitAndTag = (version: string, platform: string, shouldPush: boolean, branchRef: string) => {
  // Determine tag name based on platform
  const tagName = platform === 'all' ? `v${version}` : `v${version}-${platform}-rc`

  // Check if tag already exists BEFORE making any changes
  if (tagExists(tagName)) {
    console.error(`\n❌ Tag ${tagName} already exists!`)
    console.error(`💡 Tip: Delete the local tag with: git tag -d ${tagName}`)
    console.error('💡 Or use a different version number')
    process.exit(1)
  }

  generateChangelog(version, platform)

  console.log('\n📦 Committing changes...')

  const filesToAdd = [
    ...versionPackagePaths,
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/tauri.conf.json',
    'src-tauri/gen/android/app/tauri.properties',
  ]
  if (platform === 'all') {
    filesToAdd.push('CHANGELOG.md')
  }
  exec('git', ['add', ...filesToAdd])

  exec('git', [
    'commit',
    '-m',
    `chore: bump version to ${version}${platform === 'all' ? ' for release' : ` for ${platform} release`}`,
  ])
  console.log('  ✓ Changes committed')

  console.log(`\n🏷️  Creating tag: ${tagName}`)
  exec('git', ['tag', tagName])
  console.log('  ✓ Tag created locally')

  if (shouldPush) {
    console.log('\n📤 Pushing to remote...')
    exec('git', [...exactRefNames, 'push', 'origin', `${branchRef}:${branchRef}`])
    exec('git', ['push', 'origin', tagName])
    console.log('  ✓ Pushed to remote')

    console.log(`\n✅ Tag ${tagName} created and pushed`)
    if (platform === 'all') {
      console.log('🚀 This will trigger the release workflow to build all platforms')
    } else {
      console.log(`🚀 This will trigger the ${platform} release workflow`)
    }
  } else {
    console.log(`\n✅ Tag ${tagName} created locally`)
    console.log(`\n💡 To push and trigger CI/CD, run:`)
    console.log(`   git ${exactRefNames.join(' ')} push origin ${shellQuote(`${branchRef}:${branchRef}`)}`)
    console.log(`   git push origin ${tagName}`)
    console.log(`\n   Or run the script again with --push flag`)
  }
}

/**
 * Main function
 */
const main = () => {
  const args = parseArgs()

  if (args.help) {
    showHelp()
    process.exit(0)
  }

  // Validate arguments
  if (args.version && args.type) {
    console.error('❌ Error: Cannot specify both --version and --type')
    process.exit(1)
  }

  // Both values become git and git-cliff arguments, and version-bump.yml passes them from free-text inputs
  if (args.version && !/^\d+\.\d+\.\d+$/.test(args.version)) {
    console.error(`❌ Error: Invalid version "${args.version}". Expected X.Y.Z format.`)
    process.exit(1)
  }

  if (args.platform && !platforms.includes(args.platform)) {
    console.error(`❌ Error: Invalid platform "${args.platform}". Expected one of: ${platforms.join(', ')}`)
    process.exit(1)
  }

  // Default to auto if neither version nor type is specified
  if (!args.version && !args.type) {
    args.type = 'auto'
  }

  // Default platform to 'all'
  const platform = args.platform || 'all'

  // Check git status
  if (!args.dryRun && !isGitClean()) {
    console.error('❌ Error: Git working directory is not clean')
    console.error('Please commit or stash your changes first')
    process.exit(1)
  }

  // Determine new version
  const currentVersion = getCurrentVersion()
  console.log(`📦 Current version: ${currentVersion}`)
  console.log(`🎯 Platform: ${platform}`)

  let newVersion: string

  if (args.version) {
    newVersion = args.version
    console.log(`✨ Using specified version: ${newVersion}`)
  } else {
    const versionType = args.type === 'auto' ? detectVersionType() : args.type!
    newVersion = bumpVersion(currentVersion, versionType)
    console.log(`📈 Auto-detected version: ${newVersion} (type: ${versionType})`)
  }

  if (args.dryRun) {
    console.log('\n🧪 DRY RUN - No changes will be made')
    console.log(`\nWould update version from ${currentVersion} to ${newVersion}`)
    console.log('\nFiles that would be updated:')
    versionPackagePaths.forEach((path) => console.log(`  - ${path}`))
    console.log('  - src-tauri/Cargo.toml')
    console.log('  - src-tauri/tauri.conf.json')
    console.log('  - src-tauri/gen/android/app/tauri.properties (versionName)')
    if (platform === 'ios') {
      console.log('  - src-tauri/gen/apple/project.yml (if exists)')
    }
    if (platform === 'all') {
      console.log('  - CHANGELOG.md (regenerated via git-cliff)')
    }
    const tagName = platform === 'all' ? `v${newVersion}` : `v${newVersion}-${platform}-rc`
    console.log(`\nWould create tag: ${tagName}`)
    process.exit(0)
  }

  // Before any file changes, so a detached HEAD leaves the checkout untouched
  const branchRef = getCurrentBranchRef()

  // Update version files
  updateVersionFiles(newVersion, platform)

  // Commit and tag
  commitAndTag(newVersion, platform, args.push || false, branchRef)
}

// Run the script
main()
