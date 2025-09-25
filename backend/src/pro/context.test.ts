import { beforeEach, describe, expect, it } from 'bun:test'
import { SimpleContext } from './context'

describe('Pro - SimpleContext', () => {
  let context: SimpleContext

  beforeEach(() => {
    context = new SimpleContext()
  })

  describe('info', () => {
    it('should return a resolved promise', async () => {
      const result = await context.info('test')

      expect(result).toBeUndefined()
    })

    it('should handle empty messages', async () => {
      const result = await context.info('')

      expect(result).toBeUndefined()
    })

    it('should handle messages with special characters', async () => {
      const message = 'Message with unicode: 🚀 and newlines:\nLine 2'
      const result = await context.info(message)

      expect(result).toBeUndefined()
    })
  })

  describe('error', () => {
    it('should return a resolved promise', async () => {
      const result = await context.error('test error')

      expect(result).toBeUndefined()
    })

    it('should handle empty error messages', async () => {
      const result = await context.error('')

      expect(result).toBeUndefined()
    })

    it('should handle error messages with stack traces', async () => {
      const message = 'Error: Something went wrong\n    at Function.test (file.js:1:1)'
      const result = await context.error(message)

      expect(result).toBeUndefined()
    })
  })

  describe('concurrent operations', () => {
    it('should handle concurrent info calls', async () => {
      const messages = ['Message 1', 'Message 2', 'Message 3']

      const results = await Promise.all(messages.map((msg) => context.info(msg)))

      expect(results).toHaveLength(3)
      results.forEach((result) => {
        expect(result).toBeUndefined()
      })
    })

    it('should handle concurrent error calls', async () => {
      const errors = ['Error 1', 'Error 2', 'Error 3']

      const results = await Promise.all(errors.map((err) => context.error(err)))

      expect(results).toHaveLength(3)
      results.forEach((result) => {
        expect(result).toBeUndefined()
      })
    })

    it('should handle mixed info and error calls', async () => {
      const results = await Promise.all([context.info('Info message'), context.error('Error message'), context.info('Another info')])

      expect(results).toHaveLength(3)
      results.forEach((result) => {
        expect(result).toBeUndefined()
      })
    })
  })

  describe('integration scenarios', () => {
    it('should work in typical usage patterns', async () => {
      // Simulate a typical operation
      const infoResult1 = await context.info('Starting operation...')

      try {
        // Simulate some work
        await new Promise((resolve) => setTimeout(resolve, 1))
        const infoResult2 = await context.info('Operation completed successfully')
        expect(infoResult2).toBeUndefined()
      } catch (error) {
        await context.error(`Operation failed: ${error}`)
      }

      expect(infoResult1).toBeUndefined()
    })

    it('should handle error scenarios properly', async () => {
      const infoResult = await context.info('Starting risky operation...')

      try {
        throw new Error('Simulated error')
      } catch (error) {
        const errorResult = await context.error(`Operation failed: ${error}`)
        expect(errorResult).toBeUndefined()
      }

      expect(infoResult).toBeUndefined()
    })
  })
})
