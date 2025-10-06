#!/usr/bin/env bun
/**
 * Create Release Script
 *
 * Updates all version files, commits changes, and creates a git tag.
 * Can be run locally for testing or used in CI/CD.
 *
 * Usage:
 *   bun run scripts/create-release.ts --version 1.2.3
 *   bun run scripts/create-release.ts --type minor
 *   bun run scripts/create-release.ts --type auto
 *   bun run scripts/create-release.ts --version 1.2.3 --dry-run
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

type VersionType = 'major' | 'minor' | 'patch' | 'auto'

interface Args {
  version?: string
  type?: VersionType
  dryRun?: boolean
  help?: boolean
}

const REPO_ROOT = join(import.meta.dir, '..')

/**
 * Execute a shell command and return the output
 */
const exec = (command: string, silent = false): string => {
  try {
    return execSync(command, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: silent ? 'pipe' : 'inherit',
    }).trim()
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
    } else if (arg === '--dry-run' || arg === '-d') {
      args.dryRun = true
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
  -t, --type <type>         Version bump type: major, minor, patch, or auto
  -d, --dry-run             Show what would be done without making changes
  -h, --help                Show this help message

Examples:
  bun run scripts/create-release.ts --version 1.2.3
  bun run scripts/create-release.ts --type minor
  bun run scripts/create-release.ts --type auto
  bun run scripts/create-release.ts --version 1.2.3 --dry-run

Auto-detection rules (--type auto):
  - major: Commits contain "BREAKING" or "!"
  - minor: Commits start with "feat" or "feature"
  - patch: Everything else (bug fixes, chores, etc.)
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
 */
const bumpVersion = (current: string, type: 'major' | 'minor' | 'patch'): string => {
  const [major, minor, patch] = current.split('.').map(Number)

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
 * Update iOS project.yml version
 */
const updateProjectYml = (version: string) => {
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
 * Update all version files
 */
const updateVersionFiles = (version: string) => {
  console.log('\n📝 Updating version files to', version)
  updatePackageJson(version)
  updateCargoToml(version)
  updateTauriConf(version)
  updateProjectYml(version)
  console.log('\n  ℹ️  Note: Android versions (tauri.properties) are auto-generated by Tauri CLI')
}

/**
 * Check if git working directory is clean
 */
const isGitClean = (): boolean => {
  const status = exec('git status --porcelain', true)
  return status.length === 0
}

/**
 * Commit and tag the version
 */
const commitAndTag = (version: string) => {
  console.log('\n📦 Committing changes...')

  exec('git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json')

  const projectYmlPath = join(REPO_ROOT, 'src-tauri/gen/apple/project.yml')
  if (existsSync(projectYmlPath)) {
    exec('git add src-tauri/gen/apple/project.yml')
  }

  exec(`git commit -m "chore: bump version to ${version}"`)
  console.log('  ✓ Changes committed')

  const tagName = `v${version}`

  // Check if tag already exists
  const tagExists = exec(`git rev-parse ${tagName} 2>/dev/null || echo ''`, true)
  if (tagExists) {
    console.error(`\n❌ Tag ${tagName} already exists!`)
    process.exit(1)
  }

  console.log(`\n🏷️  Creating tag: ${tagName}`)
  exec(`git tag ${tagName}`)
  console.log('  ✓ Tag created')

  console.log('\n📤 Pushing to remote...')
  exec('git push origin main')
  exec(`git push origin ${tagName}`)
  console.log('  ✓ Pushed to remote')

  console.log(`\n✅ Tag ${tagName} created and pushed`)
  console.log('🚀 This will trigger the release workflow to build all platforms')
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
  if (!args.version && !args.type) {
    console.error('❌ Error: You must specify either --version or --type')
    console.error('Run with --help for usage information')
    process.exit(1)
  }

  if (args.version && args.type) {
    console.error('❌ Error: Cannot specify both --version and --type')
    process.exit(1)
  }

  // Check git status
  if (!args.dryRun && !isGitClean()) {
    console.error('❌ Error: Git working directory is not clean')
    console.error('Please commit or stash your changes first')
    process.exit(1)
  }

  // Determine new version
  const currentVersion = getCurrentVersion()
  console.log(`📦 Current version: ${currentVersion}`)

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
    console.log('  - src-tauri/gen/apple/project.yml (if exists)')
    console.log('\nWould create tag: v' + newVersion)
    process.exit(0)
  }

  // Update version files
  updateVersionFiles(newVersion)

  // Commit and tag
  commitAndTag(newVersion)
}

// Run the script
main()
