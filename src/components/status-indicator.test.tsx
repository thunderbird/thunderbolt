import { test, expect } from 'bun:test'
import { screen, render } from '@testing-library/react'
import { StatusIndicator } from './status-indicator'

test('StatusIndicator', () => {
  render(<StatusIndicator status="connected" />)
  const myComponent = screen.getByTestId('status-indicator')
  expect(myComponent).toBeInTheDocument()
})
