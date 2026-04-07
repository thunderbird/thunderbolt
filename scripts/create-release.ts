#!/usr/bin/env bun
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

import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

type VersionType = 'major' | 'minor' | 'patch' | 'auto'

interface Args {
  version?: string
  type?: VersionType
  platform?: 'all' | 'ios' | 'android' | 'desktop'
  dryRun?: boolean
  push?: boolean
  help?: boolean
}

const REPO_ROOT = join(import.meta.dir, '..')

/**
 * Execute a shell command and return the output
 */
// nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
// Safe: commands are constructed from hardcoded strings and locally-parsed CLI args, not from untrusted input
const exec = (command: string, silent = false): string => {
  try {
    const result = execSync(command, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: silent ? 'pipe' : 'inherit',
    })

    // Handle null or undefined results
    if (result === null || result === undefined) {
      return ''
    }

    return String(result).trim()
  } catch (error) {
    if (silent) return ''
    throw error
  }
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
      args.version = process.argv[++i]
    } else if (arg === '--type' || arg === '-t') {
      args.type = process.argv[++i] as VersionType
    } else if (arg === '--platform') {
      args.platform = process.argv[++i] as Args['platform']
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
  const pkgPath = join(REPO_ROOT, 'package.json')
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

/**
 * Auto-detect version type from commits
 */
const detectVersionType = (): 'major' | 'minor' | 'patch' => {
  // Get commits since last tag
  const lastTag = exec("git describe --tags --abbrev=0 2>/dev/null || echo ''", true)

  let commits: string
  if (lastTag) {
    commits = exec(`git log ${lastTag}..HEAD --pretty=format:"%s"`, true)
  } else {
    commits = exec('git log --pretty=format:"%s" --reverse', true)
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
 * Update package.json version
 */
const updatePackageJson = (version: string) => {
  const path = join(REPO_ROOT, 'package.json')
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  pkg.version = version
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`  ✓ package.json: ${version}`)
}

/**
 * Update Cargo.toml version
 */
const updateCargoToml = (version: string) => {
  const path = join(REPO_ROOT, 'src-tauri/Cargo.toml')
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
    exec('cd src-tauri && cargo update --workspace', true)
    console.log(`  ✓ src-tauri/Cargo.lock: updated`)
  } catch (error) {
    console.log(`  ⚠ src-tauri/Cargo.lock: could not update (cargo might not be installed)`)
  }
}

/**
 * Update tauri.conf.json version
 */
const updateTauriConf = (version: string) => {
  const path = join(REPO_ROOT, 'src-tauri/tauri.conf.json')
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

  const path = join(REPO_ROOT, 'src-tauri/gen/apple/project.yml')

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
  const path = join(REPO_ROOT, 'src-tauri/gen/android/app/tauri.properties')

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
  updatePackageJson(version)
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
  const status = exec('git status --porcelain', true)
  return status.length === 0
}

/**
 * Check if a tag exists (locally or remotely)
 */
const tagExists = (tagName: string): boolean => {
  try {
    // Check if tag exists locally
    const result = exec(`git rev-parse --verify ${tagName}`, true)
    // If the command succeeds and returns a SHA, the tag exists
    return result.length > 0 && /^[0-9a-f]{40}$/i.test(result)
  } catch {
    // Tag doesn't exist locally, check remote
    try {
      const output = exec(`git ls-remote --tags origin refs/tags/${tagName}`, true)
      return output.length > 0
    } catch {
      return false
    }
  }
}

/**
 * Commit and tag the version
 */
const commitAndTag = (version: string, platform: string, shouldPush: boolean) => {
  // Determine tag name based on platform
  const tagName = platform === 'all' ? `v${version}` : `v${version}-${platform}-rc`

  // Check if tag already exists BEFORE making any changes
  if (tagExists(tagName)) {
    console.error(`\n❌ Tag ${tagName} already exists!`)
    console.error(`💡 Tip: Delete the local tag with: git tag -d ${tagName}`)
    console.error('💡 Or use a different version number')
    process.exit(1)
  }

  console.log('\n📦 Committing changes...')

  exec(
    'git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/gen/android/app/tauri.properties',
  )

  exec(
    `git commit -m "chore: bump version to ${version}${platform === 'all' ? ' for release' : ` for ${platform} release`}"`,
  )
  console.log('  ✓ Changes committed')

  console.log(`\n🏷️  Creating tag: ${tagName}`)
  exec(`git tag ${tagName}`)
  console.log('  ✓ Tag created locally')

  if (shouldPush) {
    console.log('\n📤 Pushing to remote...')
    const currentBranch = exec('git branch --show-current', true)
    exec(`git push origin ${currentBranch}`)
    exec(`git push origin ${tagName}`)
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
    const currentBranch = exec('git branch --show-current', true)
    console.log(`   git push origin ${currentBranch}`)
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
    console.log('  - package.json')
    console.log('  - src-tauri/Cargo.toml')
    console.log('  - src-tauri/tauri.conf.json')
    console.log('  - src-tauri/gen/android/app/tauri.properties (versionName)')
    if (platform === 'ios') {
      console.log('  - src-tauri/gen/apple/project.yml (if exists)')
    }
    const tagName = platform === 'all' ? `v${newVersion}` : `v${newVersion}-${platform}-rc`
    console.log(`\nWould create tag: ${tagName}`)
    process.exit(0)
  }

  // Update version files
  updateVersionFiles(newVersion, platform)

  // Commit and tag
  commitAndTag(newVersion, platform, args.push || false)
}

// Run the script
main()
