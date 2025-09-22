import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { SimpleContext } from './context'

describe('Pro - SimpleContext', () => {
  let context: SimpleContext
  let consoleInfoSpy: any
  let consoleErrorSpy: any

  beforeEach(() => {
    context = new SimpleContext()
    // Create fresh spies for each test and reset call counts
    consoleInfoSpy?.mockRestore()
    consoleErrorSpy?.mockRestore()
    consoleInfoSpy = spyOn(console, 'info').mockImplementation(() => {})
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })

  describe('info', () => {
    it('should log info messages to console', async () => {
      const message = 'Test info message'

      await context.info(message)

      expect(consoleInfoSpy).toHaveBeenCalledWith(message)
      // Don't check exact times due to global console mocking
    })

    it('should handle empty messages', async () => {
      await context.info('')

      expect(consoleInfoSpy).toHaveBeenCalledWith('')
    })

    it('should handle messages with special characters', async () => {
      const message = 'Message with unicode: 🚀 and newlines:\nLine 2'

      await context.info(message)

      expect(consoleInfoSpy).toHaveBeenCalledWith(message)
    })

    it('should return a resolved promise', async () => {
      const result = await context.info('test')

      expect(result).toBeUndefined()
    })
  })

  describe('error', () => {
    it('should log error messages to console', async () => {
      const message = 'Test error message'

      await context.error(message)

      expect(consoleErrorSpy).toHaveBeenCalledWith(message)
      // Don't check exact times due to global console mocking
    })

    it('should handle empty error messages', async () => {
      await context.error('')

      expect(consoleErrorSpy).toHaveBeenCalledWith('')
    })

    it('should handle error messages with stack traces', async () => {
      const message = 'Error: Something went wrong\n    at Function.test (file.js:1:1)'

      await context.error(message)

      expect(consoleErrorSpy).toHaveBeenCalledWith(message)
    })

    it('should return a resolved promise', async () => {
      const result = await context.error('test error')

      expect(result).toBeUndefined()
    })
  })

  describe('concurrent logging', () => {
    it('should handle concurrent info calls', async () => {
      const messages = ['Message 1', 'Message 2', 'Message 3']

      await Promise.all(messages.map((msg) => context.info(msg)))

      // Don't check exact times due to global console mocking
      messages.forEach((msg) => {
        expect(consoleInfoSpy).toHaveBeenCalledWith(msg)
      })
    })

    it('should handle concurrent error calls', async () => {
      const errors = ['Error 1', 'Error 2', 'Error 3']

      await Promise.all(errors.map((err) => context.error(err)))

      // Don't check exact times due to global console mocking
      errors.forEach((err) => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(err)
      })
    })

    it('should handle mixed info and error calls', async () => {
      await Promise.all([context.info('Info message'), context.error('Error message'), context.info('Another info')])

      // Don't check exact times due to global console mocking
      expect(consoleInfoSpy).toHaveBeenCalledWith('Info message')
      expect(consoleInfoSpy).toHaveBeenCalledWith('Another info')
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error message')
    })
  })

  describe('integration scenarios', () => {
    it('should work in typical usage patterns', async () => {
      // Simulate a typical operation with logging
      await context.info('Starting operation...')

      try {
        // Simulate some work
        await new Promise((resolve) => setTimeout(resolve, 1))
        await context.info('Operation completed successfully')
      } catch (error) {
        await context.error(`Operation failed: ${error}`)
      }

      // Don't check exact times due to global console mocking
      expect(consoleInfoSpy).toHaveBeenCalledWith('Starting operation...')
      expect(consoleInfoSpy).toHaveBeenCalledWith('Operation completed successfully')
      // Check that error wasn't called with our specific messages
      expect(consoleErrorSpy).not.toHaveBeenCalledWith('Operation failed: Error: Simulated error')
    })

    it('should handle error scenarios properly', async () => {
      await context.info('Starting risky operation...')

      try {
        throw new Error('Simulated error')
      } catch (error) {
        await context.error(`Operation failed: ${error}`)
      }

      expect(consoleInfoSpy).toHaveBeenCalledWith('Starting risky operation...')
      expect(consoleErrorSpy).toHaveBeenCalledWith('Operation failed: Error: Simulated error')
    })
  })
})
