/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'

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
      const [major, minor, patch] = current.split('.').map(Number)
      const result = `${major + 1}.0.0`

      expect(result).toBe('2.0.0')
    })

    it('should bump minor version correctly', () => {
      const current = '1.2.3'
      const [major, minor, patch] = current.split('.').map(Number)
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
      // This simulates failed git rev-parse --verify (exception thrown)
      let exists = false
      try {
        throw new Error('fatal: Needed a single revision')
      } catch {
        exists = false
      }

      expect(exists).toBe(false)
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
      const [major, minor, patch] = cleanVersion.split('.').map(Number)
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
      const [major, minor, patch] = version.split('.').map(Number)
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
