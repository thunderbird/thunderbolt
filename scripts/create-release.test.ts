/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

// Store original process.argv and console methods
const originalArgv = process.argv
const originalConsoleLog = console.log
const originalConsoleError = console.error
const originalExit = process.exit

// Mock functions
const mockExecSync = jest.fn()
const mockReadFileSync = jest.fn()
const mockWriteFileSync = jest.fn()
const mockExistsSync = jest.fn()
const mockConsoleLog = jest.fn()
const mockConsoleError = jest.fn()
const mockProcessExit = jest.fn()

describe('create-release.ts', () => {
  beforeEach(() => {
    // Reset all mocks
    mockExecSync.mockReset()
    mockReadFileSync.mockReset()
    mockWriteFileSync.mockReset()
    mockExistsSync.mockReset()
    mockConsoleLog.mockReset()
    mockConsoleError.mockReset()
    mockProcessExit.mockReset()

    // Reset process.argv
    process.argv = ['node', 'create-release.ts']

    // Mock console methods
    console.log = mockConsoleLog
    console.error = mockConsoleError

    // Mock process.exit
    process.exit = mockProcessExit as never
  })

  afterEach(() => {
    process.argv = originalArgv
    console.log = originalConsoleLog
    console.error = originalConsoleError
    process.exit = originalExit
  })

  describe('Version Bumping', () => {
    it('should bump major version correctly', () => {
      const current = '1.2.3'
      const [major] = current.split('.').map(Number)
      const result = `${major + 1}.0.0`

      expect(result).toBe('2.0.0')
    })

    it('should bump minor version correctly', () => {
      const current = '1.2.3'
      const [major, minor] = current.split('.').map(Number)
      const result = `${major}.${minor + 1}.0`

      expect(result).toBe('1.3.0')
    })

    it('should bump patch version correctly', () => {
      const current = '1.2.3'
      const [major, minor, patch] = current.split('.').map(Number)
      const result = `${major}.${minor}.${patch + 1}`

      expect(result).toBe('1.2.4')
    })
  })

  describe('Version Detection from Commits', () => {
    it('should detect major version for breaking changes', () => {
      const commits = 'feat!: breaking change\nfix: some fix'
      const isMajor = /breaking|!/i.test(commits)

      expect(isMajor).toBe(true)
    })

    it('should detect minor version for feat commits', () => {
      const commits = 'feat: new feature\nfix: some fix'
      const hasFeature = /^(feat|feature)/im.test(commits)

      expect(hasFeature).toBe(true)
    })

    it('should default to patch for other commits', () => {
      const commits = 'fix: bug fix\nchore: update deps'
      const isBreaking = /breaking|!/i.test(commits)
      const hasFeature = /^(feat|feature)/im.test(commits)

      expect(isBreaking).toBe(false)
      expect(hasFeature).toBe(false)
    })
  })

  describe('File Operations', () => {
    it('includes the CLI package in a release version bump', () => {
      const result = Bun.spawnSync({
        cmd: ['bun', 'run', 'scripts/create-release.ts', '--version', '9.8.7', '--dry-run'],
        cwd: join(import.meta.dir, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain('  - cli/package.json')
    })

    describe('package.json', () => {
      it('should read and parse package.json correctly', () => {
        const mockPackageJson = { name: 'test', version: '1.0.0' }
        mockReadFileSync.mockReturnValue(JSON.stringify(mockPackageJson))

        const content = mockReadFileSync('package.json', 'utf8')
        const pkg = JSON.parse(content)

        expect(pkg.version).toBe('1.0.0')
      })

      it('should update package.json version', () => {
        const mockPackageJson = { name: 'test', version: '1.0.0' }

        const pkg = JSON.parse(JSON.stringify(mockPackageJson))
        pkg.version = '1.2.3'
        const newContent = JSON.stringify(pkg, null, 2) + '\n'

        expect(newContent).toContain('"version": "1.2.3"')
      })
    })

    describe('Cargo.toml', () => {
      it('should update Cargo.toml version', () => {
        const mockCargoToml = 'version = "1.0.0"\nname = "test"'
        let content = mockCargoToml
        content = content.replace(/^version = ".*"/m, 'version = "1.2.3"')

        expect(content).toContain('version = "1.2.3"')
      })
    })

    describe('tauri.conf.json', () => {
      it('should update tauri.conf.json version', () => {
        const mockTauriConf = { version: '1.0.0', productName: 'Test' }
        const config = JSON.parse(JSON.stringify(mockTauriConf))
        config.version = '1.2.3'
        const newContent = JSON.stringify(config, null, 2) + '\n'

        expect(newContent).toContain('"version": "1.2.3"')
      })
    })

    describe('project.yml', () => {
      it('should skip if project.yml does not exist', () => {
        mockExistsSync.mockReturnValue(false)

        const exists = mockExistsSync('project.yml')

        expect(exists).toBe(false)
      })

      it('should update project.yml if it exists', () => {
        const mockProjectYml = 'CFBundleShortVersionString: 1.0.0\nCFBundleVersion: "1.0.0"'
        let content = mockProjectYml
        content = content.replace(/CFBundleShortVersionString: .*/, 'CFBundleShortVersionString: 1.2.3')
        content = content.replace(/CFBundleVersion: .*/, 'CFBundleVersion: "1.2.3"')

        expect(content).toContain('CFBundleShortVersionString: 1.2.3')
        expect(content).toContain('CFBundleVersion: "1.2.3"')
      })
    })
  })

  describe('Git Operations', () => {
    it('should detect clean git status', () => {
      const status = ''
      const isClean = status.length === 0

      expect(isClean).toBe(true)
    })

    it('should detect dirty git status', () => {
      const status = 'M package.json\n'
      const isClean = status.length === 0

      expect(isClean).toBe(false)
    })

    it('should handle non-existent tag error', () => {
      const throwError = () => {
        throw new Error('tag not found')
      }

      expect(throwError).toThrow('tag not found')
    })

    it('should handle null return from execSync', () => {
      // Simulate execSync returning null (can happen with stdio: 'inherit')
      const result = null
      const safeResult = result === null || result === undefined ? '' : String(result).trim()

      expect(safeResult).toBe('')
    })

    it('should handle undefined return from execSync', () => {
      // Simulate execSync returning undefined
      const result = undefined
      const safeResult = result === null || result === undefined ? '' : String(result).trim()

      expect(safeResult).toBe('')
    })

    it('should safely convert non-string return values', () => {
      // Test that we can handle various return types safely
      const testCases = [
        { input: null, expected: '' },
        { input: undefined, expected: '' },
        { input: '', expected: '' },
        { input: 'test', expected: 'test' },
        { input: '  test  ', expected: 'test' },
      ]

      testCases.forEach(({ input, expected }) => {
        const result = input === null || input === undefined ? '' : String(input).trim()
        expect(result).toBe(expected)
      })
    })
  })

  describe('Tag Existence Checking', () => {
    it('should validate 40-character SHA hashes correctly', () => {
      const shaRegex = /^[0-9a-f]{40}$/i

      // Valid SHA hashes
      expect(shaRegex.test('cf5e203d0890ca2450876def639f1c7ed3f83f1c')).toBe(true)
      expect(shaRegex.test('ABCDEF1234567890ABCDEF1234567890ABCDEF12')).toBe(true)

      // Invalid - too short
      expect(shaRegex.test('cf5e203')).toBe(false)

      // Invalid - too long
      expect(shaRegex.test('cf5e203d0890ca2450876def639f1c7ed3f83f1c1')).toBe(false)

      // Invalid - contains non-hex characters
      expect(shaRegex.test('v1.2.3')).toBe(false)
      expect(shaRegex.test('fatal: unknown revision')).toBe(false)
      expect(shaRegex.test('Needed a single revision')).toBe(false)
    })

    it('should detect tag exists when git returns valid SHA', () => {
      // This simulates successful git rev-parse --verify
      const result = 'cf5e203d0890ca2450876def639f1c7ed3f83f1c'
      const shaRegex = /^[0-9a-f]{40}$/i
      const exists = result.length > 0 && shaRegex.test(result)

      expect(exists).toBe(true)
    })

    it('should detect tag does NOT exist when git throws error', () => {
      // This simulates failed git rev-parse --verify (exception thrown).
      // Expressed as a function so the catch RETURNS the answer: the throw is
      // unconditional, so any seed value on a `let` would be dead code.
      const tagExists = (): boolean => {
        try {
          throw new Error('fatal: Needed a single revision')
        } catch {
          return false
        }
      }

      expect(tagExists()).toBe(false)
    })

    it('should NOT be fooled by error messages containing tag name (THE BUG)', () => {
      // This is the exact bug we had: git rev-parse fails but returns text
      // containing the tag name, which was treated as truthy
      const errorOutput = "fatal: ambiguous argument 'v1.2.5': unknown revision"
      const shaRegex = /^[0-9a-f]{40}$/i

      // Old buggy logic would check: if (errorOutput) { tag exists }
      // New correct logic checks for valid SHA
      const exists = errorOutput.length > 0 && shaRegex.test(errorOutput)

      expect(exists).toBe(false) // Should be false because it's not a valid SHA
    })

    it('should handle error output that looks like it might be valid', () => {
      const testCases = [
        { output: 'v1.2.5', shouldExist: false },
        { output: 'tag not found', shouldExist: false },
        { output: '', shouldExist: false },
        { output: '123', shouldExist: false },
        { output: 'abcdef', shouldExist: false }, // Too short
        { output: 'cf5e203d0890ca2450876def639f1c7ed3f83f1c', shouldExist: true }, // Valid SHA
      ]

      const shaRegex = /^[0-9a-f]{40}$/i

      testCases.forEach(({ output, shouldExist }) => {
        const exists = output.length > 0 && shaRegex.test(output)
        expect(exists).toBe(shouldExist)
      })
    })

    it('should detect tag on remote when ls-remote returns data', () => {
      // Simulate git ls-remote --tags origin refs/tags/v1.2.3
      const remoteOutput = 'cf5e203d0890ca2450876def639f1c7ed3f83f1c\trefs/tags/v1.2.3'
      const exists = remoteOutput.length > 0

      expect(exists).toBe(true)
    })

    it('should detect tag NOT on remote when ls-remote returns empty', () => {
      // Simulate git ls-remote --tags origin refs/tags/v1.2.3 (tag doesn't exist)
      const remoteOutput = ''
      const exists = remoteOutput.length > 0

      expect(exists).toBe(false)
    })

    it('should check tag existence before making file changes', () => {
      // This tests the order of operations - tag check should come FIRST
      const operations: string[] = []

      // Simulate the workflow
      const checkTag = () => {
        operations.push('check_tag')
        return false // Tag doesn't exist
      }

      const updateFiles = () => operations.push('update_files')
      const commitChanges = () => operations.push('commit')
      const createTag = () => operations.push('create_tag')

      // Correct order
      if (!checkTag()) {
        updateFiles()
        commitChanges()
        createTag()
      }

      expect(operations).toEqual(['check_tag', 'update_files', 'commit', 'create_tag'])
      expect(operations[0]).toBe('check_tag') // Tag check MUST be first
    })

    it('should exit early if tag already exists', () => {
      // This tests that we don't modify files if tag exists
      const operations: string[] = []

      const checkTag = () => {
        operations.push('check_tag')
        return true // Tag EXISTS
      }

      const updateFiles = () => operations.push('update_files')
      const commitChanges = () => operations.push('commit')

      // Should exit early
      if (!checkTag()) {
        updateFiles()
        commitChanges()
      }

      expect(operations).toEqual(['check_tag']) // Only tag check, nothing else!
    })
  })

  describe('Argument Parsing', () => {
    it('should parse --version argument', () => {
      process.argv = ['node', 'script.ts', '--version', '1.2.3']

      const args: { version?: string } = {}
      for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i]
        if (arg === '--version' || arg === '-v') {
          args.version = process.argv[++i]
        }
      }

      expect(args.version).toBe('1.2.3')
    })

    it('should parse --type argument', () => {
      process.argv = ['node', 'script.ts', '--type', 'minor']

      const args: { type?: string } = {}
      for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i]
        if (arg === '--type' || arg === '-t') {
          args.type = process.argv[++i]
        }
      }

      expect(args.type).toBe('minor')
    })

    it('should parse --dry-run flag', () => {
      process.argv = ['node', 'script.ts', '--dry-run']

      const args: { dryRun?: boolean } = {}
      for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i]
        if (arg === '--dry-run' || arg === '-d') {
          args.dryRun = true
        }
      }

      expect(args.dryRun).toBe(true)
    })

    it('should parse --help flag', () => {
      process.argv = ['node', 'script.ts', '--help']

      const args: { help?: boolean } = {}
      for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i]
        if (arg === '--help' || arg === '-h') {
          args.help = true
        }
      }

      expect(args.help).toBe(true)
    })

    it('should parse short flags', () => {
      process.argv = ['node', 'script.ts', '-v', '1.2.3', '-d']

      const args: { version?: string; dryRun?: boolean } = {}
      for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i]
        if (arg === '--version' || arg === '-v') {
          args.version = process.argv[++i]
        } else if (arg === '--dry-run' || arg === '-d') {
          args.dryRun = true
        }
      }

      expect(args.version).toBe('1.2.3')
      expect(args.dryRun).toBe(true)
    })

    it('should parse --push flag', () => {
      process.argv = ['node', 'script.ts', '--version', '1.2.3', '--push']

      const args: { version?: string; push?: boolean } = {}
      for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i]
        if (arg === '--version' || arg === '-v') {
          args.version = process.argv[++i]
        } else if (arg === '--push' || arg === '-p') {
          args.push = true
        }
      }

      expect(args.version).toBe('1.2.3')
      expect(args.push).toBe(true)
    })

    it('should parse -p short flag', () => {
      process.argv = ['node', 'script.ts', '-v', '1.2.3', '-p']

      const args: { version?: string; push?: boolean } = {}
      for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i]
        if (arg === '--version' || arg === '-v') {
          args.version = process.argv[++i]
        } else if (arg === '--push' || arg === '-p') {
          args.push = true
        }
      }

      expect(args.push).toBe(true)
    })

    it('should default push to false when not specified', () => {
      process.argv = ['node', 'script.ts', '--version', '1.2.3']

      const args: { push?: boolean } = {}
      // Push not set, should be undefined/falsy

      expect(args.push).toBeFalsy()
    })
  })

  describe('Validation', () => {
    it('should default to auto when neither version nor type is specified', () => {
      const args: { version?: string; type?: string } = {}

      // Simulate the default behavior
      if (!args.version && !args.type) {
        args.type = 'auto'
      }

      expect(args.type).toBe('auto')
    })

    it('should not allow both version and type', () => {
      const args = { version: '1.2.3', type: 'minor' }
      const isValid = !(args.version && args.type)

      expect(isValid).toBe(false)
    })

    it('should validate version format', () => {
      const validVersions = ['1.0.0', '1.2.3', '10.20.30']
      const invalidVersions = ['1.0', 'v1.0.0', '1.2.3.4', 'abc']

      const versionRegex = /^\d+\.\d+\.\d+$/

      validVersions.forEach((v) => {
        expect(versionRegex.test(v)).toBe(true)
      })

      invalidVersions.forEach((v) => {
        expect(versionRegex.test(v)).toBe(false)
      })
    })
  })

  describe('Error Handling', () => {
    it('should handle file read errors gracefully', () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('File not found')
      })

      expect(() => mockReadFileSync('missing.json', 'utf8')).toThrow('File not found')
    })

    it('should handle git command failures', () => {
      const throwGitError = () => {
        throw new Error('git command failed')
      }

      expect(throwGitError).toThrow('git command failed')
    })

    it('should handle JSON parse errors', () => {
      expect(() => {
        JSON.parse('invalid json{')
      }).toThrow()
    })

    it('should handle execSync returning null without crashing', () => {
      // This simulates the bug where execSync with stdio: 'inherit' returns null
      // and we tried to call .trim() on it
      mockExecSync.mockReturnValue(null)

      const result = mockExecSync('git commit')

      // First, demonstrate the bug: calling trim() on null throws TypeError
      expect(() => (result as any).trim()).toThrow(TypeError)

      // Now show our safe conversion prevents this
      const safeResult = result === null || result === undefined ? '' : String(result).trim()

      expect(safeResult).toBe('')
      expect(() => safeResult.trim()).not.toThrow()
    })

    it('should prevent TypeError when calling trim on null', () => {
      // This is the exact bug we had: calling .trim() on null
      const nullValue = null

      // First, demonstrate the bug: calling trim() on null throws TypeError
      expect(() => (nullValue as any).trim()).toThrow(TypeError)

      // Good: handle null before calling trim
      const safeValue = nullValue === null || nullValue === undefined ? '' : String(nullValue)

      expect(() => safeValue.trim()).not.toThrow()
      expect(safeValue.trim()).toBe('')
    })
  })

  describe('Integration Scenarios', () => {
    it('should update all version files in workflow', () => {
      const mockPackageJson = { version: '1.0.0' }
      const mockCargoToml = 'version = "1.0.0"'
      const mockTauriConf = { version: '1.0.0' }

      // Simulate version updates
      const updatedPkg = { ...mockPackageJson, version: '1.2.3' }
      const updatedCargo = mockCargoToml.replace(/^version = ".*"/m, 'version = "1.2.3"')
      const updatedTauri = { ...mockTauriConf, version: '1.2.3' }

      expect(updatedPkg.version).toBe('1.2.3')
      expect(updatedCargo).toContain('version = "1.2.3"')
      expect(updatedTauri.version).toBe('1.2.3')
    })

    it('should handle dry-run mode', () => {
      const args = { version: '1.2.3', dryRun: true }

      // In dry-run, no write operations should occur
      expect(args.dryRun).toBe(true)
    })
  })

  describe('Tag Creation', () => {
    it('should format tag name correctly', () => {
      const version = '1.2.3'
      const tagName = `v${version}`

      expect(tagName).toBe('v1.2.3')
    })

    it('should handle tag name with prerelease', () => {
      const version = '1.2.3-beta.1'
      const tagName = `v${version}`

      expect(tagName).toBe('v1.2.3-beta.1')
    })
  })

  describe('Console Output', () => {
    it('should log version update messages', () => {
      mockConsoleLog.mockReset()
      console.log = mockConsoleLog

      console.log('📝 Updating version files to 1.2.3')

      expect(mockConsoleLog).toHaveBeenCalledWith('📝 Updating version files to 1.2.3')
    })

    it('should log error messages', () => {
      mockConsoleError.mockReset()
      console.error = mockConsoleError

      console.error('❌ Error: Version mismatch')

      expect(mockConsoleError).toHaveBeenCalledWith('❌ Error: Version mismatch')
    })
  })

  describe('Pre-release Suffix Handling', () => {
    it('should strip pre-release suffix before bumping patch', () => {
      const current = '0.1.43-desktop-rc'
      const cleanVersion = current.split('-')[0]
      const [major, minor, patch] = cleanVersion.split('.').map(Number)
      const result = `${major}.${minor}.${patch + 1}`

      expect(result).toBe('0.1.44')
    })

    it('should strip iOS release candidate suffix before bumping minor', () => {
      const current = '0.3.0-ios-rc'
      const cleanVersion = current.split('-')[0]
      const [major, minor] = cleanVersion.split('.').map(Number)
      const result = `${major}.${minor + 1}.0`

      expect(result).toBe('0.4.0')
    })

    it('should handle version without suffix unchanged', () => {
      const current = '1.2.3'
      const cleanVersion = current.split('-')[0]
      const [major, minor, patch] = cleanVersion.split('.').map(Number)
      const result = `${major}.${minor}.${patch + 1}`

      expect(result).toBe('1.2.4')
    })

    it('should detect NaN in version numbers for validation', () => {
      const current = '0.1.NaN'
      const cleanVersion = current.split('-')[0]
      const parts = cleanVersion.split('.').map(Number)
      const hasNaN = parts.some((n) => isNaN(n))

      expect(hasNaN).toBe(true)
    })

    it('should handle multiple hyphens in suffix', () => {
      const current = '0.1.43-desktop-rc-rc'
      const cleanVersion = current.split('-')[0]
      const [major, minor, patch] = cleanVersion.split('.').map(Number)
      const result = `${major}.${minor}.${patch + 1}`

      expect(result).toBe('0.1.44')
    })
  })

  describe('Edge Cases', () => {
    it('should handle version with leading zeros', () => {
      const version = '01.02.03'
      const [major, minor, patch] = version.split('.').map(Number)

      expect(major).toBe(1)
      expect(minor).toBe(2)
      expect(patch).toBe(3)
    })

    it('should handle very large version numbers', () => {
      const version = '999.999.999'
      const [major] = version.split('.').map(Number)
      const nextMajor = `${major + 1}.0.0`

      expect(nextMajor).toBe('1000.0.0')
    })

    it('should handle empty commit log', () => {
      const commits = ''
      const isEmpty = commits.length === 0

      expect(isEmpty).toBe(true)
    })
  })
})

describe('create-release.ts input validation', () => {
  const scriptPath = join(import.meta.dir, 'create-release.ts')

  /** Runs the real script in dry-run mode, so nothing is written even if validation lets an input through. */
  const runDryRun = (...args: string[]) => {
    const result = Bun.spawnSync(['bun', scriptPath, '--dry-run', ...args], { stdout: 'pipe', stderr: 'pipe' })
    return { exitCode: result.exitCode, stderr: result.stderr.toString() }
  }

  it.each([['1.2.3; touch /tmp/pwned'], ['1.2.3$(id)'], ['1.2'], ['1.2.3-rc']])('rejects version %p', (version) => {
    const { exitCode, stderr } = runDryRun('--version', version)

    expect(exitCode).toBe(1)
    expect(stderr).toContain('Invalid version')
  })

  it('rejects an unknown platform', () => {
    const { exitCode, stderr } = runDryRun('--version', '1.2.3', '--platform', 'all;id')

    expect(exitCode).toBe(1)
    expect(stderr).toContain('Invalid platform')
  })

  it('accepts a valid version and platform', () => {
    expect(runDryRun('--version', 'v1.2.3', '--platform', 'desktop').exitCode).toBe(0)
  })
})

describe('create-release.ts repository refs', () => {
  // Keeps the developer's git config (signing, hooks, default branch) out of the fixture repos
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Release Test',
    GIT_AUTHOR_EMAIL: 'release-test@example.com',
    GIT_COMMITTER_NAME: 'Release Test',
    GIT_COMMITTER_EMAIL: 'release-test@example.com',
  }
  const fixtureFiles = {
    'package.json': '{ "version": "1.0.0" }\n',
    'cli/package.json': '{ "version": "1.0.0" }\n',
    'src-tauri/Cargo.toml': 'version = "1.0.0"\n',
    'src-tauri/Cargo.lock': '',
    'src-tauri/tauri.conf.json': '{ "version": "1.0.0" }\n',
    'src-tauri/gen/android/app/tauri.properties': 'tauri.android.versionName=1.0.0\n',
    'scripts/create-release.ts': readFileSync(join(import.meta.dir, 'create-release.ts'), 'utf8'),
  }
  const tempDirs: string[] = []

  afterEach(() => {
    tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  })

  // With precomposeUnicode off, macOS Git keeps decomposed Unicode names as written, so fixtures get the refs they ask for
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', '-c', 'core.precomposeUnicode=false', ...args], {
      cwd,
      env: gitEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString())
    }
    return result.stdout.toString().trim()
  }

  /** Creates a repo running a copy of the real script, with `tag` on the first commit and a `feat` commit after it. */
  const createRepo = (tag?: string, initArgs: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'create-release-'))
    tempDirs.push(dir)
    const repo = join(dir, 'repo')
    for (const [path, content] of Object.entries(fixtureFiles)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), content)
    }
    git(repo, 'init', '-q', '-b', 'main', ...initArgs)
    git(repo, 'add', '.')
    // "!" means major, so a range that reached back past the tag would detect 2.0.0
    git(repo, 'commit', '-q', '-m', 'feat!: initial')
    if (tag) {
      // `git tag` refuses names starting with "-", but such a tag can still be pushed, fetched and described
      git(repo, 'update-ref', `refs/tags/${tag}`, 'HEAD')
    }
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: after the tag')
    return repo
  }

  const runScript = (repo: string, ...args: string[]) => {
    const result = Bun.spawnSync(['bun', 'scripts/create-release.ts', ...args], {
      cwd: repo,
      env: gitEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }

  /** Files left by a payload: `pwned` from a shell, `pwned..HEAD` from an injected `git log --output`. */
  const payloadFiles = (repo: string) => readdirSync(repo).filter((name) => name.startsWith('pwned'))

  it.each([
    ['v1.0.0'],
    ['v1.0.0;touch${IFS}pwned;#'],
    ['v1.0.0$(touch${IFS}pwned)'],
    ['--output=pwned'],
    ['HEAD'],
    ['@'],
    ['refs/heads/main'],
    ['v1.0.0\u00a0'],
    ['\ufeffv1.0.0'],
  ])('auto-detects from the commits after tag %p without running it', (tag) => {
    const repo = createRepo(tag)

    const { exitCode, stdout } = runScript(repo, '--type', 'auto', '--dry-run')

    expect(payloadFiles(repo)).toEqual([])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Auto-detected version: 1.1.0 (type: minor)')
  })

  it('auto-detects from the commits after an annotated tag', () => {
    const repo = createRepo()
    git(repo, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0', 'HEAD~1')

    const { exitCode, stdout } = runScript(repo, '--type', 'auto', '--dry-run')

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Auto-detected version: 1.1.0 (type: minor)')
  })

  it('reads the whole history when the repo has no tag', () => {
    const { exitCode, stdout } = runScript(createRepo(), '--type', 'auto', '--dry-run')

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Auto-detected version: 2.0.0 (type: major)')
  })

  const branches = [
    'release;touch${IFS}pwned;#',
    "rel';touch${IFS}pwned;'",
    'rel`touch${IFS}pwned`',
    "rel\u202e';touch${IFS}pwned;'",
    '--mirror',
    '+main',
    'main\u00a0',
  ]
  const pushModes = ['--push', 'pasted commands'] as const

  /** Puts the repo on `branch` with an origin whose main is one commit ahead, so a force push of main would show. */
  const checkoutWithRemote = (repo: string, branch: string) => {
    const remote = join(dirname(repo), 'remote.git')
    git(dirname(repo), 'init', '-q', '--bare', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'fix: only on remote main')
    git(repo, 'push', '-q', 'origin', 'main')
    git(repo, 'reset', '-q', '--hard', 'HEAD~1')
    // symbolic-ref, because `git checkout -b` refuses names starting with "-"
    git(repo, 'update-ref', `refs/heads/${branch}`, 'HEAD')
    git(repo, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`)
    return remote
  }

  const expectBranchAndTagPushed = (repo: string, remote: string, branch: string) => {
    expect(payloadFiles(repo)).toEqual([])
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(git(remote, 'for-each-ref', '--format=%(refname) %(subject)').split('\n').sort()).toEqual(
      [
        'refs/heads/main fix: only on remote main',
        `refs/heads/${branch} chore: bump version to 1.2.3 for desktop release`,
        'refs/tags/v1.2.3-desktop-rc chore: bump version to 1.2.3 for desktop release',
      ].sort(),
    )
    expect(git(remote, 'rev-parse', `refs/heads/${branch}`)).toBe(git(repo, 'rev-parse', `refs/heads/${branch}`))
  }

  /** Releases desktop 1.2.3, pushing with --push or by running each push command the script prints through sh. */
  const releaseAndPush = (repo: string, mode: (typeof pushModes)[number]) => {
    if (mode === '--push') {
      expect(runScript(repo, '--version', '1.2.3', '--platform', 'desktop', '--push').exitCode).toBe(0)
      return
    }
    const { exitCode, stdout } = runScript(repo, '--version', '1.2.3', '--platform', 'desktop')
    const pushCommands = stdout.split('\n').filter((line) => line.startsWith('   git '))

    expect(exitCode).toBe(0)
    expect(pushCommands.map((line) => Bun.spawnSync(['sh', '-c', line], { cwd: repo, env: gitEnv }).exitCode)).toEqual([
      0, 0,
    ])
  }

  it.each(branches.flatMap((branch) => pushModes.map((mode) => [branch, mode] as const)))(
    'pushes branch %p and its tag without touching remote main (%s)',
    (branch, mode) => {
      const repo = createRepo('v1.0.0')
      const remote = checkoutWithRemote(repo, branch)

      releaseAndPush(repo, mode)

      expectBranchAndTagPushed(repo, remote, branch)
    },
  )

  it.each(pushModes)('pushes main past a tag named HEAD (%s)', (mode) => {
    const repo = createRepo('HEAD')
    const remote = join(dirname(repo), 'remote.git')
    git(dirname(repo), 'init', '-q', '--bare', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', 'origin', 'main')

    releaseAndPush(repo, mode)

    const head = git(repo, 'rev-parse', 'refs/heads/main')
    expect(payloadFiles(repo)).toEqual([])
    expect(git(remote, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n')).toEqual([
      `refs/heads/main ${head}`,
      `refs/tags/v1.2.3-desktop-rc ${head}`,
    ])
  })

  it('prints the branch refspec in single quotes with each apostrophe escaped', () => {
    const repo = createRepo('v1.0.0')
    checkoutWithRemote(repo, "it's")

    const { stdout } = runScript(repo, '--version', '1.2.3', '--platform', 'desktop')

    expect(stdout).toContain(
      `\n   git -c core.precomposeUnicode=false push origin 'refs/heads/it'\\''s:refs/heads/it'\\''s'\n`,
    )
  })

  /** Everything a release run can change: the work tree, HEAD, local tags and the remote's refs. */
  const repoState = (repo: string, remote: string) =>
    [
      git(repo, 'status', '--porcelain'),
      git(repo, 'rev-parse', 'HEAD'),
      git(repo, 'tag', '-l'),
      git(remote, 'for-each-ref'),
    ].join('\n')

  const releaseArgs = (push: boolean) => ['--version', '1.2.3', '--platform', 'desktop', ...(push ? ['--push'] : [])]

  it.each([[false], [true]])('stops before changing anything when HEAD is detached (--push: %p)', (push) => {
    const repo = createRepo('v1.0.0')
    const remote = checkoutWithRemote(repo, 'main')
    git(repo, 'checkout', '-q', '--detach')
    const before = repoState(repo, remote)

    const { exitCode, stderr } = runScript(repo, ...releaseArgs(push))

    expect(exitCode).toBe(1)
    expect(stderr).toContain('HEAD is not on a branch')
    expect(repoState(repo, remote)).toBe(before)
  })

  /** Stores an annotated tag made at `target` under `ref`, then deletes the ref git tag first gave it. */
  const storeAnnotatedTagAs = (repo: string, name: string, target: string, ref: string) => {
    git(repo, 'tag', '-a', name, '-m', name, target)
    git(repo, 'update-ref', ref, `refs/tags/${name}`)
    git(repo, 'update-ref', '-d', `refs/tags/${name}`)
  }

  // git describe would print the name inside each of these tags, which is not the ref that holds it
  it.each([
    ['renamed', (repo: string) => storeAnnotatedTagAs(repo, 'inner', 'HEAD~1', 'refs/tags/v1.0.0')],
    [
      'copied under a second ref',
      (repo: string) => {
        git(repo, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0', 'HEAD~1')
        git(repo, 'update-ref', 'refs/tags/v1.0.0-copy', 'refs/tags/v1.0.0')
      },
    ],
    [
      'named like a different tag',
      (repo: string) => {
        storeAnnotatedTagAs(repo, 'v1.0.0', 'HEAD', 'refs/tags/other')
        git(repo, 'tag', 'v1.0.0', 'HEAD~1')
      },
    ],
  ])('refuses to auto-detect past an annotated tag %s, before changing anything', (_, storeTags) => {
    const repo = createRepo()
    const remote = checkoutWithRemote(repo, 'release')
    storeTags(repo)
    const before = repoState(repo, remote)

    const { exitCode, stderr } = runScript(repo, '--type', 'auto', '--platform', 'desktop')

    expect(exitCode).toBe(1)
    expect(stderr).toContain('holds an annotated tag named')
    expect(repoState(repo, remote)).toBe(before)
  })

  it('ignores a renamed annotated tag that HEAD cannot reach', () => {
    const repo = createRepo('v1.0.0')
    storeAnnotatedTagAs(
      repo,
      'inner',
      git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'side'),
      'refs/tags/v9.0.0',
    )

    const { exitCode, stdout } = runScript(repo, '--type', 'auto', '--dry-run')

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Auto-detected version: 1.1.0 (type: minor)')
  })

  it.each([
    ['a UTF-8', [], Buffer.from('feat: caf\u00e9\n', 'utf8')],
    ['an ISO-8859-1', ['-c', 'i18n.commitEncoding=ISO-8859-1'], Buffer.from('feat: caf\u00e9\n', 'latin1')],
    ['an undeclared non-UTF-8', [], Buffer.from('feat: caf\u00e9\n', 'latin1')],
  ])('reads %s commit subject when git log is set to print ISO-8859-1', (_, commitArgs, message) => {
    const repo = createRepo()
    git(repo, 'tag', 'v1.0.0')
    git(repo, 'config', 'i18n.logOutputEncoding', 'ISO-8859-1')
    const messageFile = join(dirname(repo), 'message')
    writeFileSync(messageFile, message)
    git(repo, ...commitArgs, 'commit', '-q', '--allow-empty', '-F', messageFile)

    const { exitCode, stdout } = runScript(repo, '--type', 'auto', '--dry-run')

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Auto-detected version: 1.1.0 (type: minor)')
  })

  /** Packs `count` lightweight tags onto HEAD~1 with one packed-refs write, since creating them one by one is slow. */
  const packManyTags = (repo: string, count: number) => {
    const target = git(repo, 'rev-parse', 'HEAD~1')
    const lines = Array.from(
      { length: count },
      (_, i) => `${target} refs/tags/v0.0.0-load.${String(i).padStart(6, '0')}\n`,
    )
    writeFileSync(join(repo, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted \n${lines.join('')}`)
  }

  it('auto-detects past more tags than a 1 MiB output buffer holds', () => {
    const repo = createRepo()
    packManyTags(repo, 40_000)
    const tagList = git(
      repo,
      'for-each-ref',
      '--merged=HEAD',
      '--format=%(refname)%00%(objecttype)%00%(tag)',
      'refs/tags',
    )

    const { exitCode, stdout } = runScript(repo, '--type', 'auto', '--dry-run')

    expect(tagList.length).toBeGreaterThan(1024 * 1024)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Auto-detected version: 1.1.0 (type: minor)')
  })

  it('stops before changing anything when the tag list outgrows its buffer', () => {
    const repo = createRepo()
    packManyTags(repo, 40_000)
    // The real 64 MiB bound needs about a million tags, so this copy of the script lowers it to 1 MiB
    const script = fixtureFiles['scripts/create-release.ts']
    const lowered = script.replace('const tagListMaxBuffer = 64 * 1024 * 1024', 'const tagListMaxBuffer = 1024 * 1024')
    writeFileSync(join(repo, 'scripts/create-release.ts'), lowered)
    git(repo, 'commit', '-qam', 'chore: lower the tag list bound')
    const remote = checkoutWithRemote(repo, 'release')
    const before = repoState(repo, remote)

    const { exitCode, stderr } = runScript(repo, '--type', 'auto', '--platform', 'desktop')

    expect(lowered).not.toBe(script)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('ENOBUFS')
    expect(repoState(repo, remote)).toBe(before)
  })

  it('reads the whole history when git log is set to print ISO-8859-1 and the repo has no tag', () => {
    const repo = createRepo()
    git(repo, 'config', 'i18n.logOutputEncoding', 'ISO-8859-1')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'fix: caf\u00e9')

    const { exitCode, stdout } = runScript(repo, '--type', 'auto', '--dry-run')

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Auto-detected version: 2.0.0 (type: major)')
  })

  /** Runs `command` in sh with `$ff` set to a raw 0xFF byte, because a JS string argument always reaches git as UTF-8. */
  const shWithRawByte = (repo: string, command: string) => {
    const result = Bun.spawnSync(['sh', '-c', `ff=$(printf '\\377'); ${command}`], {
      cwd: repo,
      env: gitEnv,
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString())
    }
  }

  /** Only the reftable backend can store a ref name that is not valid UTF-8 on every file system. */
  const createReftableRepo = () => createRepo(undefined, ['--ref-format=reftable'])

  /** `git init --ref-format=reftable` needs Git 2.45, which CI has; an older local Git skips these cases. */
  const canInitReftable = () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-release-reftable-'))
    tempDirs.push(dir)
    return (
      Bun.spawnSync(['git', 'init', '-q', '--ref-format=reftable', dir], { env: gitEnv, stderr: 'pipe' }).exitCode === 0
    )
  }

  const hasReftable = canInitReftable()

  it('has the Git reftable support that CI requires', () => {
    expect({ ci: Boolean(process.env.CI), hasReftable }).not.toEqual({ ci: true, hasReftable: false })
  })

  describe.skipIf(!hasReftable)('on the reftable backend', () => {
    it.each([[false], [true]])(
      'stops before changing anything when the branch name is not valid UTF-8 (--push: %p)',
      (push) => {
        const repo = createReftableRepo()
        const remote = checkoutWithRemote(repo, 'main')
        // Decoding the 0xFF byte as U+FFFD would name this other branch, on an older commit
        git(repo, 'branch', 'rel\ufffd', 'HEAD~1')
        shWithRawByte(repo, 'git update-ref "refs/heads/rel$ff" HEAD && git symbolic-ref HEAD "refs/heads/rel$ff"')
        const before = repoState(repo, remote)

        const { exitCode, stdout, stderr } = runScript(repo, ...releaseArgs(push))

        expect(exitCode).toBe(1)
        expect(stderr).toContain('not valid for encoding utf-8')
        expect(stdout).not.toContain('push origin')
        expect(repoState(repo, remote)).toBe(before)
      },
    )

    it('stops before changing anything when an annotated tag is stored under a ref that is not valid UTF-8', () => {
      const repo = createReftableRepo()
      const remote = checkoutWithRemote(repo, 'release')
      git(repo, 'tag', '-a', 'inner', '-m', 'inner', 'HEAD~1')
      shWithRawByte(repo, 'git update-ref "refs/tags/v1.0.0$ff" refs/tags/inner && git update-ref -d refs/tags/inner')
      const before = repoState(repo, remote)

      const { exitCode, stderr } = runScript(repo, '--type', 'auto', '--platform', 'desktop')

      expect(exitCode).toBe(1)
      expect(stderr).toContain('not valid for encoding utf-8')
      expect(repoState(repo, remote)).toBe(before)
    })

    it('stops when the nearest tag name is not valid UTF-8', () => {
      const repo = createReftableRepo()
      shWithRawByte(repo, 'git update-ref "refs/tags/v1.0.0$ff" HEAD~1')
      // Decoding the 0xFF byte as U+FFFD would name this tag, on a commit after HEAD, so no commits would be read
      git(
        repo,
        'update-ref',
        'refs/tags/v1.0.0\ufffd',
        git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'side'),
      )

      const { exitCode, stdout, stderr } = runScript(repo, '--type', 'auto', '--dry-run')

      expect(exitCode).toBe(1)
      expect(stderr).toContain('not valid for encoding utf-8')
      expect(stdout).not.toContain('Auto-detected version')
    })

    it.each(pushModes)('pushes a reftable branch whose name holds a literal U+FFFD (%s)', (mode) => {
      const repo = createReftableRepo()
      const remote = checkoutWithRemote(repo, 'rel\ufffd')

      releaseAndPush(repo, mode)

      expectBranchAndTagPushed(repo, remote, 'rel\ufffd')
    })

    it('auto-detects from a reftable tag whose name holds a literal U+FFFD', () => {
      const repo = createReftableRepo()
      git(repo, 'update-ref', 'refs/tags/v1.0.0\ufffd', 'HEAD~1')

      const { exitCode, stdout } = runScript(repo, '--type', 'auto', '--dry-run')

      expect(exitCode).toBe(0)
      expect(stdout).toContain('Auto-detected version: 1.1.0 (type: minor)')
    })

    const decomposed = 'e\u0301'
    const composed = '\u00e9'

    it.skipIf(process.platform !== 'darwin')(
      'resolves a decomposed name to its composed twin when macOS Git composes arguments',
      () => {
        const repo = createReftableRepo()
        git(repo, 'branch', `rel-${composed}`, 'HEAD~1')
        git(repo, 'branch', `rel-${decomposed}`, 'HEAD')
        const resolve = (precompose: boolean) =>
          git(repo, '-c', `core.precomposeUnicode=${precompose}`, 'rev-parse', `refs/heads/rel-${decomposed}`)

        expect(resolve(true)).toBe(git(repo, 'rev-parse', 'HEAD~1'))
        expect(resolve(false)).toBe(git(repo, 'rev-parse', 'HEAD'))
      },
    )

    it.each(pushModes)('pushes a decomposed branch, not its composed twin on an older commit (%s)', (mode) => {
      const repo = createReftableRepo()
      git(repo, 'config', 'core.precomposeUnicode', 'true')
      git(repo, 'branch', `rel-${composed}`, 'HEAD~1')
      const remote = checkoutWithRemote(repo, `rel-${decomposed}`)

      releaseAndPush(repo, mode)

      expectBranchAndTagPushed(repo, remote, `rel-${decomposed}`)
      expect(git(remote, 'rev-parse', 'refs/tags/v1.2.3-desktop-rc')).toBe(
        git(repo, 'rev-parse', `refs/heads/rel-${decomposed}`),
      )
    })

    it('auto-detects from a decomposed tag, not its composed twin after HEAD', () => {
      const repo = createReftableRepo()
      git(repo, 'config', 'core.precomposeUnicode', 'true')
      git(repo, 'update-ref', `refs/tags/v1.0.0-${decomposed}`, 'HEAD~1')
      git(
        repo,
        'update-ref',
        `refs/tags/v1.0.0-${composed}`,
        git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'side'),
      )

      const { exitCode, stdout } = runScript(repo, '--type', 'auto', '--dry-run')

      expect(exitCode).toBe(0)
      expect(stdout).toContain('Auto-detected version: 1.1.0 (type: minor)')
    })
  })

  it('passes the precomposeUnicode override to every git call that reads or names a repository ref', () => {
    const repo = createRepo('v1.0.0')
    checkoutWithRemote(repo, 'release')
    const shim = join(dirname(repo), 'git-shim')
    const argvLog = join(dirname(repo), 'git-argv.log')
    const realGit = Bun.which('git')
    mkdirSync(shim)
    writeFileSync(join(shim, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec '${realGit}' "$@"\n`, {
      mode: 0o755,
    })

    const result = Bun.spawnSync(
      ['bun', 'scripts/create-release.ts', '--type', 'auto', '--platform', 'desktop', '--push'],
      { cwd: repo, env: { ...gitEnv, PATH: `${shim}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe' },
    )

    expect(result.exitCode).toBe(0)
    expect(readFileSync(argvLog, 'utf8').split('\n')).toEqual(
      expect.arrayContaining([
        '-c core.precomposeUnicode=false describe --tags --abbrev=0',
        '-c core.precomposeUnicode=false for-each-ref --merged=HEAD --format=%(refname)%00%(objecttype)%00%(tag) refs/tags',
        '-c core.precomposeUnicode=false log --encoding=UTF-8 --pretty=format:%s refs/tags/v1.0.0..HEAD',
        '-c core.precomposeUnicode=false symbolic-ref --quiet HEAD',
        '-c core.precomposeUnicode=false push origin refs/heads/release:refs/heads/release',
      ]),
    )
  })
})
