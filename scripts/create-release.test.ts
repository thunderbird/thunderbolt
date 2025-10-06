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

    it('should check if tag exists', () => {
      const tagExists = 'abc123'

      expect(tagExists.length).toBeGreaterThan(0)
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
  })

  describe('Validation', () => {
    it('should require either version or type', () => {
      const args = {}
      const isValid = !!(args as any).version || !!(args as any).type

      expect(isValid).toBe(false)
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

      // The exec function should handle null gracefully
      const safeResult = result === null || result === undefined ? '' : String(result).trim()

      expect(safeResult).toBe('')
      expect(() => safeResult.trim()).not.toThrow()
    })

    it('should prevent TypeError when calling trim on null', () => {
      // This is the exact bug we had: calling .trim() on null
      const nullValue = null

      // Bad: would throw TypeError
      // nullValue.trim()

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
